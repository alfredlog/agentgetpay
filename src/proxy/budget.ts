// Budgets en mémoire. Node.js exécute ce code sans interruption, donc la réservation est atomique.
// Trois compteurs par agent : le jour, le mois, et le mois par catégorie d'achat (hôtel, fournitures…).
// Au démarrage, ils sont recalculés depuis le journal d'audit : redémarrer le proxy ne remet PAS les budgets à zéro.
// En entreprise (plusieurs serveurs), on remplace par Redis avec un script atomique.
import { BudgetStore, BudgetLimits, LedgerEntry } from './types.js'

// Le "jour" et le "mois" d'un budget suivent l'heure de Berlin (minuit à Berlin, pas minuit UTC)
export const dayOf = (d: Date | string) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })
export const monthOf = (d: Date | string) => dayOf(d).slice(0, 7)

// Une remise à zéro faite dans l'administration (ne concerne que le compteur du jour)
export const isBudgetReset = (e: LedgerEntry) =>
  e.decision === 'admin' && (e.action === 'budget_reset' || (e.reason ?? '').startsWith("Today's spending reset"))

export class MemoryBudgetStore implements BudgetStore {
  private spent = new Map<string, number>()
  private dayKey = (a: string) => `${a}|d|${dayOf(new Date())}`
  private monthKey = (a: string, cat?: string) => `${a}|m|${monthOf(new Date())}${cat ? `|${cat}` : ''}`
  private add(k: string, sats: number) { this.spent.set(k, Math.max(0, (this.spent.get(k) ?? 0) + sats)) }
  // "travel.hotel" compte aussi dans "travel" : un plafond peut porter sur la catégorie ou sa famille
  private addCategory(a: string, category: string, sats: number) {
    for (let c = category; c; c = c.includes('.') ? c.slice(0, c.lastIndexOf('.')) : '') this.add(this.monthKey(a, c), sats)
  }

  // Recalcule les compteurs du jour et du mois depuis le journal
  restoreFrom(entries: LedgerEntry[]) {
    const today = dayOf(new Date()), month = monthOf(new Date())
    this.spent.clear()
    for (const e of entries) {
      if (monthOf(e.ts) !== month) continue
      if (isBudgetReset(e)) { if (dayOf(e.ts) === today) this.spent.delete(this.dayKey(e.agentId)); continue }
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

  async release(agentId: string, sats: number, category?: string) {
    this.add(this.dayKey(agentId), -sats)
    this.add(this.monthKey(agentId), -sats)
    if (category) this.addCategory(agentId, category, -sats)
  }
}
