// Human approval. Requests are stored (RequestStore): a channel only ALERTS a human
// and PASSES ON their decision. A decision may arrive hours or days later, even after a restart.
import type { StoredRequest } from './requests.js'
import { fmt } from './policy.js'

export type DecisionHandler = (requestId: string, approved: boolean, by: string) => Promise<string> | string

export interface ApprovalNotifier {
  readonly name: string
  // Alerts a human; returns what is needed to find the message again (to update it later)
  notify(r: StoredRequest): Promise<Record<string, unknown> | undefined>
  // The request is over (decided elsewhere, executed, expired): update the message
  closed(r: StoredRequest, outcome: string): Promise<void>
  onDecision(handler: DecisionHandler): void
}

// Text of a request, readable on a phone
export function describeRequest(r: StoredRequest): string {
  const until = new Date(r.expiresAt).toLocaleString('en-GB', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' })
  if (r.kind === 'mandate' && r.mandate) {
    return [
      `🔁 Standing approval requested (${r.id})`,
      `Agent: ${r.agentId}`,
      `Merchant: ${r.mandate.domain}${r.mandate.category ? ` · ${r.mandate.category}` : ''}`,
      `Up to ${fmt(r.mandate.maxEurPerMonth)} per month for ${r.mandate.months} month(s)`,
      `Agent's purpose: ${r.purpose ?? '—'}`,
      `Open until: ${until}`
    ].join('\n')
  }
  let service = r.url ?? ''
  try { const u = new URL(service); service = `${u.host}${u.pathname}` } catch {}
  const o = r.order
  return [
    `🔔 Approval requested (${r.id})`,
    `Agent: ${r.agentId}`,
    `Amount: ${fmt(r.amountEur ?? 0)} (${r.amountSats} sats)`,
    o ? `Merchant: ${o.merchant} · ${o.category}` : `Service: ${service}`,
    ...(o ? [`Items: ${o.items.map(i => `${i.quantity}× ${i.name}`).join(', ')}`] : []),
    ...(o?.shipTo ? [`Delivery: ${o.shipTo.street}, ${o.shipTo.postalCode} ${o.shipTo.city}`] : []),
    `Agent's purpose: ${r.purpose ?? '—'}`,
    `Rule: ${r.reason}`,
    `Open until: ${until}`
  ].join('\n')
}

// --- Telegram: a message with two buttons on your phone ---
export class TelegramNotifier implements ApprovalNotifier {
  readonly name = 'telegram'
  private api: string
  private offset = 0
  private handler?: DecisionHandler

  constructor(token: string, private chatId: string, apiBase = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org') {
    this.api = `${apiBase}/bot${token}`
    void this.checkToken()
    void this.poll()
  }

  onDecision(handler: DecisionHandler) { this.handler = handler }

  private async checkToken() {
    try {
      const r = (await (await fetch(`${this.api}/getMe`)).json()) as { ok: boolean; result?: { username: string } }
      if (r.ok) console.log(`Telegram connected: @${r.result!.username}`)
      else console.error('⚠ Telegram token rejected: check TELEGRAM_BOT_TOKEN in .env (no quotes, no "bot" prefix)')
    } catch {
      console.error('⚠ Telegram unreachable (internet connection?)')
    }
  }

  async notify(r: StoredRequest) {
    const text = describeRequest(r)
    const sent = await this.call('sendMessage', {
      chat_id: this.chatId, text,
      reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `ok:${r.id}` }, { text: '❌ Reject', callback_data: `no:${r.id}` }]] }
    })
    return sent?.message_id ? { telegram: { chatId: this.chatId, messageId: sent.message_id, text } } : undefined
  }

  async closed(r: StoredRequest, outcome: string) {
    const t = r.notices?.telegram as { chatId: string; messageId: number; text: string } | undefined
    if (!t) return
    await this.call('editMessageText', { chat_id: t.chatId, message_id: t.messageId, text: `${t.text}\n\n${outcome}` })
  }

  // Listens to button clicks (long polling: no public server needed)
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
          const who = cq.from?.username ? `@${cq.from.username}` : cq.from?.first_name ?? 'unknown'
          const answer = this.handler ? await this.handler(id, action === 'ok', who) : 'Not ready'
          await this.call('answerCallbackQuery', { callback_query_id: cq.id, text: answer })
        }
      } catch (e) {
        console.error('Telegram unreachable, retrying in 5 s:', (e as Error).message)
        await new Promise(r => setTimeout(r, 5000))
      }
    }
  }

  // Returns Telegram's result (e.g. the message sent), or undefined on error
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

// --- Without Telegram: decisions are made on the dashboard, nothing to send ---
export class DashboardOnlyNotifier implements ApprovalNotifier {
  readonly name = 'dashboard'
  async notify() { return undefined }
  async closed() {}
  onDecision() {}
}

// --- Automatic answer, for tests without a phone ---
export class AutoNotifier implements ApprovalNotifier {
  readonly name = 'auto'
  private handler?: DecisionHandler
  constructor(private answer: 'approved' | 'rejected', private delayMs = 0) {}
  onDecision(handler: DecisionHandler) { this.handler = handler }
  async notify(r: StoredRequest) {
    console.log(`(test) Auto-answer "${this.answer}" for ${r.id} — ${r.reason}`)
    setTimeout(() => void this.handler?.(r.id, this.answer === 'approved', 'test-auto'), this.delayMs)
    return undefined
  }
  async closed() {}
}
