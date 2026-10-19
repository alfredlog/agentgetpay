// Validation humaine. Le proxy ne connaît que l'interface ApprovalChannel.
import { ApprovalChannel, PaymentRequest } from './types.js'
import { fmt } from './policy.js'

type Result = Awaited<ReturnType<ApprovalChannel['requestApproval']>>

// --- Version Telegram : un message avec deux boutons sur ton téléphone ---
export class TelegramApprovalChannel implements ApprovalChannel {
  private api: string
  private pending = new Map<string, (r: Result) => void>()
  private offset = 0

  constructor(token: string, private chatId: string, private timeoutMs = 120_000,
              apiBase = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org') {
    this.api = `${apiBase}/bot${token}`
    void this.checkToken()
    void this.poll()
  }

  // Au démarrage : vérifie le token et affiche le nom du bot
  private async checkToken() {
    try {
      const r = (await (await fetch(`${this.api}/getMe`)).json()) as { ok: boolean; result?: { username: string } }
      if (r.ok) console.log(`Telegram connected: @${r.result!.username}`)
      else console.error('⚠ Telegram token rejected: check TELEGRAM_BOT_TOKEN in .env (no quotes, no "bot" prefix)')
    } catch {
      console.error('⚠ Telegram unreachable (internet connection?)')
    }
  }

  async requestApproval(req: PaymentRequest, reason: string): Promise<Result> {
    const id = Math.random().toString(36).slice(2, 10)
    const text = [
      '🔔 Approval requested',
      `Agent: ${req.agentId}`,
      `Amount: ${fmt(req.amountEur)} (${req.amountSats} sats)`,
      `Service: ${new URL(req.url).host}${new URL(req.url).pathname}`,
      `Agent's purpose: ${req.purpose ?? '—'}`,
      `Rule: ${reason}`
    ].join('\n')

    const sent = await this.call('sendMessage', {
      chat_id: this.chatId, text,
      reply_markup: { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `ok:${id}` },
        { text: '❌ Reject', callback_data: `no:${id}` }
      ]] }
    })
    // Si le message n'est pas parti, inutile de faire attendre l'agent 2 minutes
    if (!sent) return { status: 'rejected', by: 'Telegram error (message not sent)' }

    return new Promise<Result>(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ status: 'timeout' }) }, this.timeoutMs)
      this.pending.set(id, r => { clearTimeout(timer); resolve(r) })
    })
  }

  // Écoute les clics sur les boutons (long polling : pas besoin de serveur public)
  private async poll() {
    for (;;) {
      try {
        const res = await fetch(`${this.api}/getUpdates?timeout=30&offset=${this.offset}&allowed_updates=["callback_query"]`)
        const data = (await res.json()) as { result?: any[] }
        for (const u of data.result ?? []) {
          this.offset = u.update_id + 1
          const cq = u.callback_query
          if (!cq?.data) continue
          const [action, id] = String(cq.data).split(':')
          const done = this.pending.get(id)
          const who = cq.from?.username ? `@${cq.from.username}` : cq.from?.first_name ?? 'unknown'
          await this.call('answerCallbackQuery', { callback_query_id: cq.id })
          if (!done) continue
          this.pending.delete(id)
          const approved = action === 'ok'
          await this.call('editMessageText', {
            chat_id: cq.message.chat.id, message_id: cq.message.message_id,
            text: `${cq.message.text}\n\n${approved ? '✅ Approved' : '❌ Rejected'} by ${who}`
          })
          done({ status: approved ? 'approved' : 'rejected', by: who })
        }
      } catch (e) {
        console.error('Telegram unreachable, retrying in 5 s:', (e as Error).message)
        await new Promise(r => setTimeout(r, 5000))
      }
    }
  }

  private async call(method: string, body: object) {
    const res = await fetch(`${this.api}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    if (!res.ok) console.error(`Telegram ${method} :`, await res.text())
    return res.ok
  }
}

// --- Version automatique, pour les tests sans téléphone ---
export class AutoApprovalChannel implements ApprovalChannel {
  constructor(private answer: 'approved' | 'rejected') {}
  async requestApproval(req: PaymentRequest, reason: string): Promise<Result> {
    console.log(`(test) Auto-approval "${this.answer}" for ${fmt(req.amountEur)} — ${reason}`)
    return { status: this.answer, by: 'test-auto' }
  }
}
