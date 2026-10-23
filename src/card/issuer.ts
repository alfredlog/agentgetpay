// Card issuer: creates virtual cards for agents.
//
// The interface follows what real card-issuing platforms offer (Stripe Issuing, and European corporate-card
// providers with an API): a virtual card per purchase, with a spending limit, an expiry date, and REAL-TIME
// AUTHORIZATION: when the card is used, the card network asks the issuer, which asks us, "approve this charge?".
// That last part is what makes the control real: the proxy decides every charge, the agent cannot bypass it.
//
// Hackathon: SimulatedIssuer (no real money, test card numbers). Enterprise: a class that calls the
// issuer's API and receives its authorization webhook; nothing else in the proxy changes.
import { randomInt, randomBytes } from 'node:crypto'

export interface CardSpec {
  agentId: string
  limitCents: number
  currency: 'EUR'
  merchantName: string
  merchantDomain: string
  validUntil: string // ISO date
}

// Full card details: returned ONCE, to be used by the agent at the merchant's checkout
export interface IssuedCard {
  cardId: string
  brand: string
  number: string
  cvc: string
  expMonth: number
  expYear: number
  last4: string
}

export interface CardIssuer {
  readonly name: string
  create(spec: CardSpec): Promise<IssuedCard>
  cancel(cardId: string): Promise<void>
}

// Luhn check digit, so the simulated numbers look like real card numbers
function luhn(partial: string) {
  let sum = 0
  for (let i = 0; i < partial.length; i++) {
    let d = Number(partial[partial.length - 1 - i])
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return String((10 - (sum % 10)) % 10)
}
export const validCardNumber = (n: string) => /^\d{16}$/.test(n) && luhn(n.slice(0, 15)) === n[15]

// --- Simulated issuer: test card numbers starting with 4000 00 (never valid on a real network) ---
export class SimulatedIssuer implements CardIssuer {
  readonly name = 'simulated'

  async create(spec: CardSpec): Promise<IssuedCard> {
    const body = '400000' + Array.from({ length: 9 }, () => randomInt(10)).join('')
    const number = body + luhn(body)
    const exp = new Date(spec.validUntil)
    return {
      cardId: `card_${randomBytes(8).toString('hex')}`, brand: 'Visa (simulated)', number,
      cvc: String(randomInt(1000)).padStart(3, '0'), expMonth: exp.getUTCMonth() + 1, expYear: exp.getUTCFullYear(), last4: number.slice(-4)
    }
  }

  async cancel() {}
}

// --- Enterprise: a real issuing platform ---
// To connect one (e.g. Stripe Issuing), implement CardIssuer with its API:
//   create(): create a virtual card for a cardholder, with spending controls (amount limit, allowed merchant
//             categories) and the expiry date; return its id and details.
//   cancel(): set the card status to canceled.
// and route the platform's real-time authorization webhook to cardRail.authorize(cardId, charge), answering
// approve/decline within the platform's time limit (about 2 seconds for Stripe). Verify the webhook signature.
export class NotConfiguredIssuer implements CardIssuer {
  readonly name = 'not-configured'
  async create(): Promise<IssuedCard> { throw new Error('No card issuer configured (set CARD_ISSUER=simulated for the demo)') }
  async cancel() {}
}
