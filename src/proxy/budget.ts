// In-memory budgets. Node.js runs this code without interruption, so the reservation is atomic.
// Three counters per agent: the day, the month, and the month per purchase category (hotel, supplies…).
// At startup they are rebuilt from the audit log: restarting the proxy does NOT reset the budgets.
// In an enterprise setup (several servers), replace this with Redis and an atomic script.
import { BudgetStore, BudgetLimits, LedgerEntry } from './types.js'

// A budget's "day" and "month" follow Berlin time (midnight in Berlin, not midnight UTC)
export const dayOf = (d: Date | string) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })
export const monthOf = (d: Date | string) => dayOf(d).slice(0, 7)

// A reset made on the admin page (only affects the daily counter)
export const isBudgetReset = (e: LedgerEntry) =>
  e.decision === 'admin' && (e.action === 'budget_reset' || (e.reason ?? '').startsWith("Today's spending reset"))

export class MemoryBudgetStore implements BudgetStore {
  private spent = new Map<string, number>()
  private dayKey = (a: string) => `${a}|d|${dayOf(new Date())}`
  private monthKey = (a: string, cat?: string) => `${a}|m|${monthOf(new Date())}${cat ? `|${cat}` : ''}`
  private add(k: string, sats: number) { this.spent.set(k, Math.max(0, (this.spent.get(k) ?? 0) + sats)) }
  // "travel.hotel" also counts in "travel": a limit can apply to the category or to its family
  private addCategory(a: string, category: string, sats: number) {
    for (let c = category; c; c = c.includes('.') ? c.slice(0, c.lastIndexOf('.')) : '') this.add(this.monthKey(a, c), sats)
  }

  // Rebuilds the daily and monthly counters from the audit log
  restoreFrom(entries: LedgerEntry[]) {
    const today = dayOf(new Date()), month = monthOf(new Date())
    this.spent.clear()
    const payments = new Map<string, LedgerEntry>()
    for (const e of entries) {
      if (e.decision === 'allow' && e.txid) payments.set(e.txid, e)
      if (monthOf(e.ts) !== month) continue
      if (isBudgetReset(e)) { if (dayOf(e.ts) === today) this.spent.delete(this.dayKey(e.agentId)); continue }
      if (e.decision === 'refund') {
        const orig = e.refundOf ? payments.get(e.refundOf) : undefined
        if (orig) this.credit(e.agentId, e.amountSats, orig.order?.category, orig.ts)
        continue
      }
      if (e.decision !== 'allow') continue
      if (dayOf(e.ts) === today) this.add(this.dayKey(e.agentId), e.amountSats)
      this.add(this.monthKey(e.agentId), e.amountSats)
      if (e.order?.category) this.addCategory(e.agentId, e.order.category, e.amountSats)
    }
  }

  async spentToday(agentId: string) { return this.spent.get(this.dayKey(agentId)) ?? 0 }
  async spentThisMonth(agentId: string, category?: string) { return this.spent.get(this.monthKey(agentId, category)) ?? 0 }

  async tryReserve(agentId: string, sats: number, l: BudgetLimits) {
    const day = await this.spentToday(agentId), month = await this.spentThisMonth(agentId)
    if (day + sats > l.daySats) return 'Daily budget exceeded'
    if (l.monthSats !== undefined && month + sats > l.monthSats) return 'Monthly budget exceeded'
    if (l.categoryKey && l.categoryMonthSats !== undefined && (await this.spentThisMonth(agentId, l.categoryKey)) + sats > l.categoryMonthSats) {
      return `Monthly ${l.categoryKey} budget exceeded`
    }
    this.add(this.dayKey(agentId), sats)
    this.add(this.monthKey(agentId), sats)
    if (l.category) this.addCategory(agentId, l.category, sats)
    return undefined
  }

  async reset(agentId: string) { this.spent.delete(this.dayKey(agentId)) }

  // Refund: gives the amount back to the day, month and category of the original payment (if still current)
  credit(agentId: string, sats: number, category: string | undefined, originalTs: string) {
    if (monthOf(originalTs) !== monthOf(new Date())) return
    if (dayOf(originalTs) === dayOf(new Date())) this.add(this.dayKey(agentId), -sats)
    this.add(this.monthKey(agentId), -sats)
    if (category) this.addCategory(agentId, category, -sats)
  }

  // Holds an amount without checking limits (a virtual card that is still open, after a restart)
  hold(agentId: string, sats: number, category?: string) {
    this.add(this.dayKey(agentId), sats)
    this.add(this.monthKey(agentId), sats)
    if (category) this.addCategory(agentId, category, sats)
  }

  async release(agentId: string, sats: number, category?: string) {
    this.add(this.dayKey(agentId), -sats)
    this.add(this.monthKey(agentId), -sats)
    if (category) this.addCategory(agentId, category, -sats)
  }
}
