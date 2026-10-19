// Budgets en mémoire. Node.js exécute ce code sans interruption, donc la réservation est atomique.
// En entreprise (plusieurs serveurs), on remplace par Redis avec un script atomique.
import { BudgetStore } from './types.js'

export class MemoryBudgetStore implements BudgetStore {
  private spent = new Map<string, number>()
  private key = (agentId: string) => `${agentId}:${new Date().toISOString().slice(0, 10)}`

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
  async release(agentId: string, sats: number) {
    const k = this.key(agentId)
    this.spent.set(k, Math.max(0, (this.spent.get(k) ?? 0) - sats))
  }
}
