// Card rail: lets agents pay merchants that do not accept BSV yet (hotels, airlines, shops…), under the SAME
// company rules, approvals and audit log as the BSV rail.
//
//   1. The agent asks for a virtual card: merchant, amount, category, items, purpose.
//   2. AgentGetPay applies the purchase policy, asks a human if needed (even days later).
//   3. A single-use virtual card is issued: limited to that amount (+ optional tolerance), that merchant,
//      and a validity period. The budget is held right away.
//   4. When the merchant charges the card, the card network asks us in real time: we approve only if the charge
//      matches what was approved (amount, merchant, merchant category, card still open, agent active).
//   5. The charge is recorded in the hash-chained audit log, anchored on BSV, and exported to DATEV like any
//      other payment. Re-using the card, or using it elsewhere, is declined in real time.
//
// Card numbers are never stored: only hashes (to recognise the card at authorization) and the last 4 digits.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CardIssuer, IssuedCard } from './issuer.js'
import type { OrderInfo } from '../shared/x402.js'
import type { CardTerms } from '../proxy/requests.js'
import type { MemoryBudgetStore } from '../proxy/budget.js'
import type { JsonPolicyEngine } from '../proxy/policy.js'
import { fmt } from '../proxy/policy.js'
import type { Ledger } from '../proxy/types.js'

// Merchant category codes (MCC) → purchase categories. A card for "travel.hotel" is declined at a shop with MCC 5943.
export const MCC_CATEGORIES: Record<string, string> = {
  '7011': 'travel.hotel', '3501': 'travel.hotel', '4511': 'travel.flight', '4112': 'travel.train', '4121': 'travel.taxi',
  '5943': 'office.supplies', '5111': 'office.supplies', '5044': 'office.equipment',
  '5734': 'software', '5817': 'software', '7372': 'software',
  '5812': 'food.restaurant', '5814': 'food.restaurant'
}

export interface CardRecord {
  cardId: string
  agentId: string
  brand: string
  last4: string
  numberHash: string
  cvcHash: string
  expMonth: number
  expYear: number
  merchantName: string
  merchantDomain: string
  category?: string
  amountEur: number
  limitEur: number
  limitSats: number
  order?: OrderInfo
  purpose?: string
  requestId?: string
  approvedBy?: string
  createdAt: string
  validUntil: string
  status: 'active' | 'used' | 'expired' | 'cancelled'
  authId?: string
  authorizedEur?: number
  usedAt?: string
  declines: number
}

export interface CardCharge {
  amountCents: number
  currency: string
  merchantName: string
  merchantDomain: string
  mcc?: string
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

class CardStore {
  private items: CardRecord[]
  constructor(private path = 'data/cards.json') {
    this.items = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
  }
  save() {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.items, null, 2))
    renameSync(`${this.path}.tmp`, this.path)
  }
  add(c: CardRecord) { this.items.push(c); this.save() }
  get(id: string) { return this.items.find(c => c.cardId === id) }
  byNumber(number: string) { const h = sha256(number); return this.items.find(c => sameText(c.numberHash, h)) }
  list() { return [...this.items] }
}

export interface CardRailDeps {
  issuer: CardIssuer
  eurPerSat: number
  budget: MemoryBudgetStore
  policy: JsonPolicyEngine
  record: (e: Parameters<Ledger['record']>[0]) => Promise<unknown>
  isActive: (agentId: string) => boolean
  path?: string
}

// What an agent and the admin page see (never the hashes)
export const cardView = ({ numberHash, cvcHash, ...c }: CardRecord) => c

export function createCardRail(d: CardRailDeps) {
  const store = new CardStore(d.path)
  const sats = (eur: number) => Math.round(eur / d.eurPerSat)
  const label = (c: Pick<CardRecord, 'last4' | 'merchantName'>) => `card •••• ${c.last4} (${c.merchantName})`

  // Issues a card after the policy (and, if needed, a human) said yes. Holds the budget for the card limit.
  async function issue(agentId: string, t: CardTerms, extra: { order?: OrderInfo; purpose?: string; requestId?: string; approvedBy?: string }): Promise<{ card: CardRecord; details: IssuedCard }> {
    const limitSats = sats(t.limitEur)
    const over = await d.budget.tryReserve(agentId, limitSats, d.policy.limitsFor(agentId, t.category))
    if (over) throw new Error(over)
    const validUntil = new Date(Date.now() + t.validDays * 864e5).toISOString()
    let details: IssuedCard
    try {
      details = await d.issuer.create({ agentId, limitCents: Math.round(t.limitEur * 100), currency: 'EUR', merchantName: t.merchantName, merchantDomain: t.merchantDomain, validUntil })
    } catch (e) {
      await d.budget.release(agentId, limitSats, t.category)
      throw e
    }
    const card: CardRecord = {
      cardId: details.cardId, agentId, brand: details.brand, last4: details.last4, numberHash: sha256(details.number), cvcHash: sha256(details.cvc),
      expMonth: details.expMonth, expYear: details.expYear, merchantName: t.merchantName, merchantDomain: t.merchantDomain, category: t.category,
      amountEur: t.amountEur, limitEur: t.limitEur, limitSats, order: extra.order, purpose: extra.purpose, requestId: extra.requestId,
      approvedBy: extra.approvedBy, createdAt: new Date().toISOString(), validUntil, status: 'active', declines: 0
    }
    store.add(card)
    await d.record({
      agentId, url: `card://${t.merchantDomain}`, amountSats: limitSats, amountEur: t.limitEur, purpose: extra.purpose, decision: 'card', rail: 'card',
      cardId: card.cardId, order: extra.order, requestId: extra.requestId, approvedBy: extra.approvedBy,
      reason: `Virtual ${label(card)} issued: limit ${fmt(t.limitEur)}, valid until ${validUntil.slice(0, 10)}`
    })
    console.log(`💳 ${agentId}: virtual ${label(card)} issued, limit ${fmt(t.limitEur)}`)
    return { card, details }
  }

  // Real-time authorization: the card network asks "approve this charge?". Same role as an issuer's webhook.
  async function authorize(cardId: string, ch: CardCharge): Promise<{ approved: boolean; reason?: string; authId?: string }> {
    const c = store.get(cardId)
    if (!c) return { approved: false, reason: 'Unknown card' }
    const eur = ch.amountCents / 100
    const decline = async (reason: string) => {
      c.declines++
      store.save()
      await d.record({
        agentId: c.agentId, url: `https://${ch.merchantDomain}/`, amountSats: sats(eur), amountEur: eur, purpose: c.purpose, decision: 'deny', rail: 'card',
        cardId: c.cardId, order: c.order, requestId: c.requestId, reason: `${label(c)} declined in real time: ${reason}`
      })
      console.log(`✘ ${c.agentId}: ${label(c)} declined — ${reason}`)
      return { approved: false, reason }
    }
    if (c.status !== 'active') return decline(c.status === 'used' ? 'single-use card already used' : `card ${c.status}`)
    if (c.validUntil < new Date().toISOString()) return decline('card expired')
    if (!d.isActive(c.agentId)) return decline('agent suspended by an administrator')
    if (ch.currency !== 'EUR') return decline(`currency ${ch.currency} not allowed`)
    const domain = String(ch.merchantDomain ?? '').toLowerCase()
    if (domain !== c.merchantDomain) return decline(`merchant ${ch.merchantName} (${domain}) is not the approved merchant (${c.merchantDomain})`)
    const mapped = ch.mcc ? MCC_CATEGORIES[ch.mcc] : undefined
    if (c.category && mapped && !(mapped === c.category || mapped.startsWith(`${c.category}.`) || c.category.startsWith(`${mapped}.`))) {
      return decline(`merchant category ${mapped} (MCC ${ch.mcc}) does not match ${c.category}`)
    }
    if (!(eur > 0) || eur > c.limitEur + 1e-9) return decline(`${fmt(eur)} is above the card limit (${fmt(c.limitEur)})`)

    // Approved: the card is used, the hold becomes the real amount
    const authId = `auth_${randomBytes(8).toString('hex')}`
    Object.assign(c, { status: 'used', authId, authorizedEur: eur, usedAt: new Date().toISOString() })
    store.save()
    await d.budget.release(c.agentId, c.limitSats, c.category)
    d.budget.hold(c.agentId, sats(eur), c.category)
    await d.record({
      agentId: c.agentId, url: `https://${domain}/`, amountSats: sats(eur), amountEur: eur, purpose: c.purpose, decision: 'allow', rail: 'card',
      cardId: c.cardId, authId, order: c.order, requestId: c.requestId, approvedBy: c.approvedBy
    })
    void d.issuer.cancel(c.cardId).catch(() => {}) // single use
    console.log(`✔ ${c.agentId} paid ${fmt(eur)} with ${label(c)} — ${authId}`)
    return { approved: true, authId }
  }

  // The simulated card network: a merchant submits the card details; we find the card and authorize
  async function networkAuthorize(b: { number?: string; cvc?: string; expMonth?: number; expYear?: number } & CardCharge) {
    const c = b.number ? store.byNumber(String(b.number).replace(/\s/g, '')) : undefined
    if (!c) return { approved: false, reason: 'Unknown card number' }
    if (!sameText(c.cvcHash, sha256(String(b.cvc ?? ''))) || Number(b.expMonth) !== c.expMonth || Number(b.expYear) !== c.expYear) {
      return { approved: false, reason: 'Wrong security code or expiry date' }
    }
    return authorize(c.cardId, b)
  }

  async function close(c: CardRecord, status: 'expired' | 'cancelled', why: string) {
    c.status = status
    store.save()
    await d.budget.release(c.agentId, c.limitSats, c.category)
    void d.issuer.cancel(c.cardId).catch(() => {})
    await d.record({ agentId: c.agentId, url: `card://${c.merchantDomain}`, amountSats: 0, amountEur: 0, decision: 'card', rail: 'card', cardId: c.cardId, requestId: c.requestId, reason: `Virtual ${label(c)} ${why}; ${fmt(c.limitEur)} released` })
  }

  // Cards past their date: closed, budget released
  async function sweep() {
    const now = new Date().toISOString()
    for (const c of store.list()) if (c.status === 'active' && c.validUntil < now) await close(c, 'expired', 'expired unused')
  }

  async function cancel(cardId: string, by: string) {
    const c = store.get(cardId)
    if (!c || c.status !== 'active') return undefined
    await close(c, 'cancelled', `cancelled by ${by}`)
    return c
  }

  // After a restart: the budget is rebuilt from paid entries; open cards still hold their limit
  function restoreHolds() {
    for (const c of store.list()) if (c.status === 'active') d.budget.hold(c.agentId, c.limitSats, c.category)
  }

  return { issue, authorize, networkAuthorize, sweep, cancel, restoreHolds, list: () => store.list().map(cardView), get: (id: string) => store.get(id) }
}

export type CardRail = ReturnType<typeof createCardRail>
