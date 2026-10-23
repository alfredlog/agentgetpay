// Moteur de règles : règles par agent, lues dans le registre (config/policies.json).
// Comme la politique d'achats d'une entreprise : budgets jour/mois, marchands autorisés,
// règles par catégorie (hôtel max 150 €/nuit…), adresses de livraison autorisées, validation humaine.
import { PolicyEngine, PaymentRequest, Decision, BudgetStore } from './types.js'
import type { ShippingAddress } from '../shared/x402.js'

// Règles d'une catégorie d'achat. Tout est facultatif.
export interface CategoryRule {
  max_unit_price_eur?: number  // prix maximum par unité (une nuit d'hôtel, un article, un mois d'abonnement)
  monthly_budget_eur?: number  // plafond du mois pour cette catégorie
  approval_above_eur?: number  // seuil de validation propre à la catégorie (plus strict que le seuil général)
}

export interface Rules {
  daily_budget_eur: number
  monthly_budget_eur?: number
  max_per_payment_eur: number
  approval_above_eur: number
  allowed_domains: string[]
  // Si la liste existe, un achat décrit par le marchand doit appartenir à l'une de ces catégories
  categories?: Record<string, CategoryRule>
  // Adresses où l'agent a le droit de se faire livrer (en général : les sites de l'entreprise)
  shipping_addresses?: ShippingAddress[]
}

// Deux adresses sont "la même" si code postal, ville, pays et rue (sans espaces ni ponctuation) correspondent
// (München = Muenchen, Leopoldstraße 1 = Leopoldstr. 1)
const norm = (s: string | undefined) => String(s ?? '').toLowerCase()
  .replace(/straße|strasse/g, 'str').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')
export const sameAddress = (a: ShippingAddress, b: ShippingAddress) =>
  norm(a.postalCode) === norm(b.postalCode) && norm(a.city) === norm(b.city) && norm(a.country) === norm(b.country) && norm(a.street) === norm(b.street)
export const formatAddress = (a: ShippingAddress) => `${a.street}, ${a.postalCode} ${a.city}, ${a.country}`

// Une catégorie "travel.hotel" utilise les règles de "travel.hotel", sinon celles de "travel"
export function categoryRule(rules: Rules, category: string): { key: string; rule: CategoryRule } | undefined {
  if (!rules.categories) return undefined
  for (let c = category; c; c = c.includes('.') ? c.slice(0, c.lastIndexOf('.')) : '') {
    if (rules.categories[c]) return { key: c, rule: rules.categories[c] }
  }
  return undefined
}

export class JsonPolicyEngine implements PolicyEngine {
  // Les règles sont relues à chaque paiement : une modification dans l'administration s'applique tout de suite
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

    // ---- Règles d'achat (si le marchand décrit ce qu'il vend) ----
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

    // ---- Validation humaine : seuil général, ou seuil plus strict de la catégorie ----
    if (req.amountEur > r.approval_above_eur) {
      return { kind: 'needs_approval', reason: `${fmt(req.amountEur)} exceeds approval threshold (${fmt(r.approval_above_eur)})` }
    }
    const catAppr = cat?.rule.approval_above_eur
    if (catAppr !== undefined && req.amountEur > catAppr) {
      return { kind: 'needs_approval', reason: `${fmt(req.amountEur)} exceeds the ${cat!.key} approval threshold (${fmt(catAppr)})` }
    }
    return { kind: 'allow' }
  }

  // Plafonds à réserver au moment de payer (en sats)
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
