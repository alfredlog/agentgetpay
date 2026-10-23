// Mandats : une validation donnée UNE fois pour des achats qui reviennent (abonnement, API au mois…).
// Exemple : « docs-01 peut payer cloudsoft jusqu'à 30 €/mois pendant 12 mois ».
// Tant que le mandat est actif, ces paiements n'attendent plus de validation humaine.
// Le mandat ne contourne JAMAIS les autres règles (domaines, catégories, budgets, livraison).
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { MandateTerms } from './requests.js'

export interface Mandate extends MandateTerms {
  id: string            // ex. "M-4F2A9C"
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

  // Le mandat qui couvre ce paiement, s'il existe. usedThisMonth(id) = euros déjà payés sous ce mandat ce mois-ci.
  covering(agentId: string, host: string, category: string | undefined, amountEur: number, usedThisMonth: (id: string) => number) {
    return this.active(agentId).find(m =>
      m.domain === host &&
      (!m.category || (category !== undefined && (category === m.category || category.startsWith(`${m.category}.`)))) &&
      usedThisMonth(m.id) + amountEur <= m.maxEurPerMonth + 1e-9)
  }
}
