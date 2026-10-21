// Budgets en mémoire. Node.js exécute ce code sans interruption, donc la réservation est atomique.
// Au démarrage, les dépenses du jour sont recalculées depuis le journal d'audit :
// redémarrer le proxy ne remet donc PAS les budgets à zéro.
// En entreprise (plusieurs serveurs), on remplace par Redis avec un script atomique.
import { BudgetStore, LedgerEntry } from './types.js'

// Le "jour" d'un budget suit l'heure de Berlin (minuit à Berlin, pas minuit UTC)
export const dayOf = (d: Date | string) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })

// Une remise à zéro faite dans l'administration
export const isBudgetReset = (e: LedgerEntry) =>
  e.decision === 'admin' && (e.action === 'budget_reset' || (e.reason ?? '').startsWith("Today's spending reset"))

export class MemoryBudgetStore implements BudgetStore {
  private spent = new Map<string, number>()
  private key = (agentId: string, day = dayOf(new Date())) => `${agentId}:${day}`

  // Recalcule les dépenses du jour : somme des paiements, depuis la dernière remise à zéro
  restoreFrom(entries: LedgerEntry[]) {
    const today = dayOf(new Date())
    this.spent.clear()
    for (const e of entries) {
      if (dayOf(e.ts) !== today) continue
      const k = this.key(e.agentId, today)
      if (isBudgetReset(e)) this.spent.delete(k)
      else if (e.decision === 'allow') this.spent.set(k, (this.spent.get(k) ?? 0) + e.amountSats)
    }
  }

  async spentToday(agentId: string) {
    return this.spent.get(this.key(agentId)) ?? 0
  }
  async tryReserve(agentId: string, sats: number, limitSats: number) {
    const k = this.key(agentId)
    const current = this.spent.get(k) ?? 0
    if (current + sats > limitSats) return false
    this.spent.set(k, current + sats)
    return true
  }
  async reset(agentId: string) {
    this.spent.delete(this.key(agentId))
  }
  async release(agentId: string, sats: number) {
    const k = this.key(agentId)
    this.spent.set(k, Math.max(0, (this.spent.get(k) ?? 0) - sats))
  }
}
