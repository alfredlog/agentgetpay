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

  async requestApproval(req: PaymentRequest, reason: string, signal?: AbortSignal): Promise<Result> {
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
      const finish = (r: Result) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.pending.delete(id); resolve(r) }
      const timer = setTimeout(() => {
        finish({ status: 'timeout' })
        void this.call('editMessageText', { chat_id: this.chatId, message_id: sent.message_id, text: `${text}\n\n⌛ No answer: payment refused` })
      }, this.timeoutMs)
      // Décision prise sur le tableau de bord : on met le message à jour et on retire les boutons
      const onAbort = () => {
        if (!this.pending.has(id)) return
        const r = (signal?.reason ?? {}) as Result
        finish(r)
        const outcome = r.status === 'approved' ? `✅ Approved by ${r.by}` : r.status === 'rejected' ? `❌ Rejected by ${r.by}` : '⌛ Closed'
        void this.call('editMessageText', { chat_id: this.chatId, message_id: sent.message_id, text: `${text}\n\n${outcome}` })
      }
      this.pending.set(id, finish)
      signal?.addEventListener('abort', onAbort)
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

  // Renvoie le résultat de Telegram (ex. le message envoyé), ou undefined en cas d'erreur
  private async call(method: string, body: object): Promise<any> {
    try {
      const res = await fetch(`${this.api}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      })
      if (!res.ok) { console.error(`Telegram ${method} :`, await res.text()); return undefined }
      return ((await res.json()) as { result?: unknown }).result ?? true
    } catch (e) {
      console.error(`Telegram ${method} unreachable:`, (e as Error).message)
      return undefined
    }
  }
}

// --- Sans Telegram : on attend une décision sur le tableau de bord ---
export class DashboardOnlyApprovalChannel implements ApprovalChannel {
  constructor(private timeoutMs = 120_000) {}
  requestApproval(_req: PaymentRequest, _reason: string, signal?: AbortSignal): Promise<Result> {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve({ status: 'timeout' }), this.timeoutMs)
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve((signal.reason ?? { status: 'timeout' }) as Result) })
    })
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
