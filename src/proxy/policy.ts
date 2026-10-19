// Moteur de règles simple : règles par agent dans config/policies.json.
import { readFileSync } from 'node:fs'
import { PolicyEngine, PaymentRequest, Decision, BudgetStore } from './types.js'

export interface Rules {
  daily_budget_eur: number
  max_per_payment_eur: number
  approval_above_eur: number
  allowed_domains: string[]
}

export class JsonPolicyEngine implements PolicyEngine {
  private rules: Record<string, Rules>

  constructor(path: string, private budget: BudgetStore, private eurPerSat: number) {
    this.rules = JSON.parse(readFileSync(path, 'utf8'))
  }

  rulesFor(agentId: string): Rules | undefined {
    return this.rules[agentId]
  }

  async evaluate(req: PaymentRequest): Promise<Decision> {
    const r = this.rules[req.agentId]
    if (!r) return { kind: 'deny', reason: 'No rules for this agent' }

    const host = new URL(req.url).hostname
    if (!r.allowed_domains.includes(host)) {
      return { kind: 'deny', reason: `Domain not allowed: ${host}` }
    }
    if (req.amountEur > r.max_per_payment_eur) {
      return { kind: 'deny', reason: `${fmt(req.amountEur)} exceeds max per payment (${fmt(r.max_per_payment_eur)})` }
    }
    const spentEur = (await this.budget.spentToday(req.agentId)) * this.eurPerSat
    if (spentEur + req.amountEur > r.daily_budget_eur) {
      return { kind: 'deny', reason: `Daily budget exceeded (${fmt(spentEur)} of ${fmt(r.daily_budget_eur)} already spent)` }
    }
    if (req.amountEur > r.approval_above_eur) {
      return { kind: 'needs_approval', reason: `${fmt(req.amountEur)} exceeds approval threshold (${fmt(r.approval_above_eur)})` }
    }
    return { kind: 'allow' }
  }
}

export const fmt = (eur: number) => `€${eur.toFixed(2)}`
