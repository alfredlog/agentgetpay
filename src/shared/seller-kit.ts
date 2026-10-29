// Seller kit: lets AI agents pay for any Express route, via HTTP 402 with BRC-121
// (Simple 402 Payments, @bsv/402-pay). The merchant's wallet-toolbox wallet receives
// each payment (internalizeAction): the satoshis are spendable at once.
//
//   const seller = createSeller({ wallet })
//   app.post(QUOTE_PATH, express.json(), seller.quote)        // free quotes (order details)
//   app.get('/api/report', seller.requirePayment('GET /api/report', 30, 'Full report'), (req, res) => res.json({ ... }))
//
// The price can also be computed from the request body, with the order description
// (merchant, category, items, delivery). BRC-121's 402 only carries the price and the
// merchant's identity key, so the order is published by the free quote endpoint: the buyer
// reads it BEFORE paying and can apply its purchase policy.
//
// Refunds: a BRC-29 payment from the merchant wallet to the buyer's identity key (the
// x-bsv-sender of the original payment), returned in the JSON body of the cancel answer.
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { WalletInterface } from './bsv.js'
import { createPaymentMiddleware, InMemoryPaymentReplayStore, type PaymentResult, type PaymentReplayStore } from './brc121.js'
import { createBrc29Payment, type Brc29Payment } from './payments.js'
import type { OrderInfo, Quote, QuoteRequest } from './order.js'

// Fixed price, or price computed from the request body with the order description
export type Pricing = number | ((body: any) => { amount: number; order?: OrderInfo } | { error: string })

// A paid request, as kept by the merchant (enough to refund it later, even after a restart)
export interface PaidOrder {
  txid: string
  sats: number
  payer: string // the buyer's identity key (x-bsv-sender): refunds go back to it
  resource: string
  order?: OrderInfo
}

// What the cancel answer carries: the BRC-29 refund and the payment it refunds
export type RefundNotice = Brc29Payment & { paymentTxid: string }

export interface SellerOptions {
  wallet: WalletInterface
  // Shared atomic store when more than one process serves the paid routes (guide §10.5)
  replayStore?: PaymentReplayStore
  // Called when a request is paid (seller's log, "recent orders" page…)
  onPaid?: (paid: PaidOrder, req: Request, res: Response) => void
  log?: (msg: string) => void
}

const routeKey = (method: string, path: string) => `${method.toUpperCase()} ${path.split('?')[0]}`

export function createSeller(o: SellerOptions) {
  if (!o.wallet) throw new Error('Merchant wallet missing')
  const log = o.log ?? ((m: string) => console.log(m))
  const replayStore = o.replayStore ?? new InMemoryPaymentReplayStore()
  const routes = new Map<string, { pricing: Pricing; description: string }>() // "POST /api/hotels/book" → price

  const priceOf = (pricing: Pricing, body: unknown) => typeof pricing === 'number' ? { amount: pricing, order: undefined } : pricing(body)

  // Middleware: protects a route with a price. `resource` is "METHOD /path", as the quote endpoint looks it up.
  function requirePayment(resource: string, pricing: Pricing, description: string): RequestHandler {
    const [method, path] = resource.trim().split(/\s+/)
    routes.set(routeKey(method, path), { pricing, description })
    return async (req: Request, res: Response, next: NextFunction) => {
      const priced = priceOf(pricing, req.body)
      if ('error' in priced) return void res.status(400).json({ error: priced.error })
      const { amount, order } = priced
      // The price depends on the request (body), while 402-pay asks the price per path:
      // one middleware per request, all sharing the same wallet and replay store.
      const pay = createPaymentMiddleware({ wallet: o.wallet, calculatePrice: () => amount, replayStore })
      await pay(req, res, () => {
        const p = (req as Request & { payment?: PaymentResult }).payment
        if (p) {
          const paid: PaidOrder = { txid: p.txid, sats: p.satoshisPaid, payer: p.senderIdentityKey, resource: routeKey(req.method, req.path), order }
          res.locals.payment = paid
          log(`Paid: ${paid.sats} sats for ${paid.resource} — tx ${paid.txid}`)
          o.onPaid?.(paid, req, res)
        }
        next()
      })
    }
  }

  // Free quote: what a request would cost and what it buys, without paying (and without side effects)
  const quote: RequestHandler = (req, res) => {
    const q = req.body as QuoteRequest | undefined
    const route = routes.get(routeKey(String(q?.method ?? 'GET'), String(q?.path ?? '')))
    if (!route) return void res.status(404).json({ error: 'No paid route here' })
    const priced = priceOf(route.pricing, q?.body)
    if ('error' in priced) return void res.status(400).json({ error: priced.error })
    const answer: Quote = { sats: priced.amount, description: route.description, ...(priced.order ? { order: priced.order } : {}) }
    res.json(answer)
  }

  // Refunds a paid request: a BRC-29 payment of `sats` (default: all of it) to the buyer's identity key.
  // The merchant wallet pays the network fee.
  async function refund(paid: PaidOrder, sats = paid.sats): Promise<RefundNotice> {
    if (!Number.isSafeInteger(sats) || sats < 1 || sats > paid.sats) throw new Error('Invalid refund amount')
    const p = await createBrc29Payment(o.wallet, paid.payer, sats, `Refund of ${paid.txid.slice(0, 16)}`)
    log(`Refunded ${sats} sats for ${paid.txid} — tx ${p.txid}`)
    return { ...p, paymentTxid: paid.txid }
  }

  return { requirePayment, quote, refund, wallet: o.wallet }
}
