// Rules engine: per-agent rules, read from the registry (config/policies.json).
// Like a company's purchasing policy: daily/monthly budgets, allowed merchants,
// per-category rules (hotel max €150/night…), allowed delivery addresses, human approval.
import { PolicyEngine, PaymentRequest, Decision, BudgetStore } from './types.js'
import type { ShippingAddress } from '../shared/x402.js'

// Rules of one purchase category. Everything is optional.
export interface CategoryRule {
  max_unit_price_eur?: number  // maximum price per unit (a hotel night, an item, a month of subscription)
  monthly_budget_eur?: number  // monthly limit for this category
  approval_above_eur?: number  // approval threshold specific to the category (stricter than the general one)
}

export interface Rules {
  daily_budget_eur: number
  monthly_budget_eur?: number
  max_per_payment_eur: number
  approval_above_eur: number
  allowed_domains: string[]
  // If the list exists, a purchase described by the merchant must belong to one of these categories
  categories?: Record<string, CategoryRule>
  // Addresses the agent may have goods delivered to (usually the company's sites)
  shipping_addresses?: ShippingAddress[]
  // How this agent may pay: the COMPANY decides, not the AI. Default: BSV only.
  payment_methods?: PaymentMethod[]
  // Virtual cards only for these purchase categories (e.g. ["travel"]); empty = any allowed category
  card_categories?: string[]
  // BSV first (default true): refuse a card when the merchant accepts BSV
  card_only_if_no_bsv?: boolean
}

export type PaymentMethod = 'bsv' | 'card'
export const methodsOf = (r: Rules): PaymentMethod[] => r.payment_methods?.length ? r.payment_methods : ['bsv']
const covers = (parent: string, cat: string) => cat === parent || cat.startsWith(`${parent}.`)

// Two addresses are "the same" if postcode, city, country and street (without spaces or punctuation) match
// (München = Muenchen, Leopoldstraße 1 = Leopoldstr. 1)
const norm = (s: string | undefined) => String(s ?? '').toLowerCase()
  .replace(/straße|strasse/g, 'str').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')
export const sameAddress = (a: ShippingAddress, b: ShippingAddress) =>
  norm(a.postalCode) === norm(b.postalCode) && norm(a.city) === norm(b.city) && norm(a.country) === norm(b.country) && norm(a.street) === norm(b.street)
export const formatAddress = (a: ShippingAddress) => `${a.street}, ${a.postalCode} ${a.city}, ${a.country}`

// A "travel.hotel" category uses the rules of "travel.hotel", otherwise those of "travel"
export function categoryRule(rules: Rules, category: string): { key: string; rule: CategoryRule } | undefined {
  if (!rules.categories) return undefined
  for (let c = category; c; c = c.includes('.') ? c.slice(0, c.lastIndexOf('.')) : '') {
    if (rules.categories[c]) return { key: c, rule: rules.categories[c] }
  }
  return undefined
}

export class JsonPolicyEngine implements PolicyEngine {
  // Rules are re-read on every payment: a change on the admin page applies immediately
  constructor(private source: { rulesFor(id: string): Rules | undefined }, private budget: BudgetStore, private eurPerSat: number) {}

  rulesFor(agentId: string): Rules | undefined {
    return this.source.rulesFor(agentId)
  }

  async evaluate(req: PaymentRequest): Promise<Decision> {
    const r = this.rulesFor(req.agentId)
    if (!r) return { kind: 'deny', reason: 'No rules for this agent' }
    const eur = (sats: number) => sats * this.eurPerSat

    const host = new URL(req.url).hostname
    if (!r.allowed_domains.includes(host)) {
      return { kind: 'deny', reason: `Domain not allowed: ${host}` }
    }

    // ---- Payment method chosen by the company ----
    const rail = req.rail ?? 'bsv'
    if (!methodsOf(r).includes(rail)) {
      return { kind: 'deny', reason: rail === 'card' ? 'Card payments are not allowed for this agent (company setting)' : 'BSV payments are not allowed for this agent (company setting)' }
    }
    if (rail === 'card' && r.card_categories?.length) {
      const cat = req.order?.category
      if (!cat || !r.card_categories.some(c => covers(c, cat))) {
        return { kind: 'deny', reason: `Cards are only allowed for: ${r.card_categories.join(', ')} (this purchase: ${cat ?? 'no category'})` }
      }
    }

    // ---- Purchase rules (if the merchant describes what it sells) ----
    let cat: ReturnType<typeof categoryRule>
    const o = req.order
    if (o) {
      const total = o.items.reduce((s, i) => s + i.quantity * i.unitPriceSats, 0)
      if (!o.items.length || total !== req.amountSats) {
        return { kind: 'deny', reason: `The order total (${total} sats) does not match the price asked (${req.amountSats} sats)` }
      }
      cat = categoryRule(r, o.category)
      if (r.categories && !cat) return { kind: 'deny', reason: `Purchase category not allowed: ${o.category}` }
      const maxUnit = cat?.rule.max_unit_price_eur
      if (maxUnit !== undefined) {
        const tooExpensive = o.items.find(i => eur(i.unitPriceSats) > maxUnit)
        if (tooExpensive) {
          return { kind: 'deny', reason: `${tooExpensive.name}: ${fmt(eur(tooExpensive.unitPriceSats))} per ${tooExpensive.unit ?? 'item'} exceeds the ${cat!.key} limit (${fmt(maxUnit)})` }
        }
      }
      if (o.shipTo) {
        const allowed = r.shipping_addresses ?? []
        if (!allowed.some(a => sameAddress(a, o.shipTo!))) {
          return { kind: 'deny', reason: `Delivery address not allowed: ${formatAddress(o.shipTo)}` }
        }
      }
    }

    if (req.amountEur > r.max_per_payment_eur) {
      return { kind: 'deny', reason: `${fmt(req.amountEur)} exceeds max per payment (${fmt(r.max_per_payment_eur)})` }
    }
    const day = eur(await this.budget.spentToday(req.agentId))
    if (day + req.amountEur > r.daily_budget_eur) {
      return { kind: 'deny', reason: `Daily budget exceeded (${fmt(day)} of ${fmt(r.daily_budget_eur)} already spent)` }
    }
    if (r.monthly_budget_eur !== undefined) {
      const month = eur(await this.budget.spentThisMonth(req.agentId))
      if (month + req.amountEur > r.monthly_budget_eur) {
        return { kind: 'deny', reason: `Monthly budget exceeded (${fmt(month)} of ${fmt(r.monthly_budget_eur)} already spent)` }
      }
    }
    if (cat?.rule.monthly_budget_eur !== undefined) {
      const catMonth = eur(await this.budget.spentThisMonth(req.agentId, cat.key))
      if (catMonth + req.amountEur > cat.rule.monthly_budget_eur) {
        return { kind: 'deny', reason: `Monthly ${cat.key} budget exceeded (${fmt(catMonth)} of ${fmt(cat.rule.monthly_budget_eur)} already spent)` }
      }
    }

    // ---- Human approval: general threshold, or the stricter category threshold ----
    if (req.amountEur > r.approval_above_eur) {
      return { kind: 'needs_approval', reason: `${fmt(req.amountEur)} exceeds approval threshold (${fmt(r.approval_above_eur)})` }
    }
    const catAppr = cat?.rule.approval_above_eur
    if (catAppr !== undefined && req.amountEur > catAppr) {
      return { kind: 'needs_approval', reason: `${fmt(req.amountEur)} exceeds the ${cat!.key} approval threshold (${fmt(catAppr)})` }
    }
    return { kind: 'allow' }
  }

  // Limits to reserve at payment time (in sats)
  limitsFor(agentId: string, category?: string) {
    const r = this.rulesFor(agentId)!
    const sats = (eur: number) => Math.floor(eur / this.eurPerSat + 1e-9)
    const cat = category ? categoryRule(r, category) : undefined
    return {
      daySats: sats(r.daily_budget_eur),
      monthSats: r.monthly_budget_eur !== undefined ? sats(r.monthly_budget_eur) : undefined,
      category,
      categoryKey: cat?.key,
      categoryMonthSats: cat?.rule.monthly_budget_eur !== undefined ? sats(cat.rule.monthly_budget_eur) : undefined
    }
  }
}

export const fmt = (eur: number) => `€${eur.toFixed(2)}`
