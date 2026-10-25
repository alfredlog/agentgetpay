// Mandates: an approval given ONCE for purchases that repeat (subscription, monthly API…).
// Example: "docs-01 may pay cloudsoft up to €30/month for 12 months".
// While the mandate is active, these payments no longer wait for human approval.
// A mandate NEVER bypasses the other rules (domains, categories, budgets, delivery).
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { MandateTerms } from './requests.js'

export interface Mandate extends MandateTerms {
  id: string            // e.g. "M-4F2A9C"
  agentId: string
  purpose?: string
  approvedBy: string
  createdAt: string
  validUntil: string
  revokedAt?: string
  revokedBy?: string
  requestId?: string
}

export class MandateStore {
  private items: Mandate[]

  constructor(private path = 'data/mandates.json') {
    this.items = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.items, null, 2))
    renameSync(`${this.path}.tmp`, this.path)
  }

  list() { return [...this.items] }
  active(agentId?: string) {
    const now = new Date().toISOString()
    return this.items.filter(m => !m.revokedAt && m.validUntil > now && (!agentId || m.agentId === agentId))
  }

  create(m: Omit<Mandate, 'id' | 'createdAt' | 'validUntil'>): Mandate {
    const until = new Date()
    until.setMonth(until.getMonth() + m.months)
    const mandate: Mandate = { ...m, id: `M-${randomBytes(3).toString('hex').toUpperCase()}`, createdAt: new Date().toISOString(), validUntil: until.toISOString() }
    this.items.push(mandate)
    this.save()
    return mandate
  }

  revoke(id: string, by: string) {
    const m = this.items.find(x => x.id === id && !x.revokedAt)
    if (!m) return undefined
    m.revokedAt = new Date().toISOString()
    m.revokedBy = by
    this.save()
    return m
  }

  // The mandate covering this payment, if any. usedThisMonth(id) = euros already paid under this mandate this month.
  covering(agentId: string, host: string, category: string | undefined, amountEur: number, usedThisMonth: (id: string) => number) {
    return this.active(agentId).find(m =>
      m.domain === host &&
      (!m.category || (category !== undefined && (category === m.category || category.startsWith(`${m.category}.`)))) &&
      usedThisMonth(m.id) + amountEur <= m.maxEurPerMonth + 1e-9)
  }
}
