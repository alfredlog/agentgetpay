// The BUYER side: a fetch() that can pay a 402 response with BRC-121 (@bsv/402-pay).
// The payment proxy plugs its rules engine into `beforePay`, which runs BEFORE anything is signed.
//
//   1. request → 402 with x-bsv-sats (price) and x-bsv-server (merchant identity key)
//   2. free quote (QUOTE_PATH) → order details: merchant, category, items, delivery
//   3. beforePay(offer) → the purchase policy decides
//   4. constructPaymentHeaders (BRC-29 payment to the merchant) → same request again, paid
import { Beef, Utils, type WalletInterface } from '../shared/bsv.js'
import { BRC121, constructPaymentHeaders, withHostOriginator } from '../shared/brc121.js'
import { QUOTE_PATH, type OrderInfo, type Quote } from '../shared/order.js'
import type { Mutex } from '../shared/mutex.js'

export interface Offer {
  url: string
  amount: number   // x-bsv-sats
  server: string   // x-bsv-server: the merchant's identity key (the payment is derived for it)
  order?: OrderInfo
  description?: string
}

export interface PayFetchOptions {
  wallet: WalletInterface // the payer's wallet-toolbox wallet
  maxSats?: number        // simple safeguard
  beforePay?: (offer: Offer) => Promise<boolean>
  beforeSpend?: (offer: Offer) => Promise<void> // inside spendLock, right before the payment (e.g. allowance top-up)
  spendLock?: Mutex       // only one payment at a time spends the wallet
}

export interface PayFetchResult {
  response: Response
  paid?: { amount: number; txid: string }
}

// Order description sent by the merchant: only a valid, reasonably sized shape is kept
export function validOrder(o: unknown): OrderInfo | undefined {
  const x = o as OrderInfo | undefined
  if (!x || typeof x !== 'object' || typeof x.merchant !== 'string' || typeof x.category !== 'string' || !Array.isArray(x.items)) return undefined
  if (x.items.length > 100) return undefined
  const items = x.items.map(i => ({
    name: String(i?.name ?? '').slice(0, 120), quantity: Number(i?.quantity), unitPriceSats: Number(i?.unitPriceSats),
    ...(i?.unit ? { unit: String(i.unit).slice(0, 20) } : {})
  }))
  if (items.some(i => !Number.isInteger(i.quantity) || i.quantity < 1 || !Number.isInteger(i.unitPriceSats) || i.unitPriceSats < 0)) return undefined
  const s = x.shipTo
  const shipTo = s && typeof s === 'object'
    ? { ...(s.name ? { name: String(s.name).slice(0, 80) } : {}), street: String(s.street ?? '').slice(0, 120), postalCode: String(s.postalCode ?? '').slice(0, 12), city: String(s.city ?? '').slice(0, 80), country: String(s.country ?? '').slice(0, 2).toUpperCase() }
    : undefined
  return { merchant: x.merchant.slice(0, 80), category: x.category.toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 60), items, ...(shipTo ? { shipTo } : {}) }
}

// The BRC-121 challenge of a 402 answer, or undefined if it is not a valid one
export function readChallenge(res: Response): { amount: number; server: string } | undefined {
  if (res.status !== 402) return undefined
  const sats = res.headers.get(BRC121.SATS) ?? ''
  const server = res.headers.get(BRC121.SERVER) ?? ''
  if (!/^[1-9]\d{0,15}$/.test(sats) || !Number.isSafeInteger(Number(sats)) || !/^0[23][0-9a-f]{64}$/.test(server)) return undefined
  return { amount: Number(sats), server }
}

// Asks the merchant's free quote endpoint what this request buys. undefined if it has none.
export async function fetchQuote(url: string, method: string, body?: string): Promise<Quote | undefined> {
  const u = new URL(url)
  let parsed: unknown
  try { parsed = body === undefined ? undefined : JSON.parse(body) } catch { parsed = undefined }
  const res = await fetch(new URL(QUOTE_PATH, u.origin), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'manual',
    body: JSON.stringify({ method, path: u.pathname + u.search, body: parsed }), signal: AbortSignal.timeout(10_000)
  }).catch(() => undefined)
  if (!res?.ok) return undefined
  const q = await res.json().catch(() => undefined) as Quote | undefined
  if (!q || !Number.isSafeInteger(q.sats) || q.sats < 0) return undefined
  return { sats: q.sats, description: typeof q.description === 'string' ? q.description.slice(0, 200) : undefined, order: validOrder(q.order) }
}

// The payment was sent, but the merchant did not deliver (fresh 402, or the paid request failed)
export class PaidNotDelivered extends Error {
  constructor(public paid: { amount: number; txid: string }, detail: string) {
    super(`Paid ${paid.amount} sats (tx ${paid.txid}), but the merchant did not deliver: ${detail}`)
  }
}

const bodyText = (init: RequestInit) => typeof init.body === 'string' ? init.body : undefined

export async function payFetch(url: string, init: RequestInit, opts: PayFetchOptions): Promise<PayFetchResult> {
  // 1. First attempt, without paying
  const first = await fetch(url, init)
  if (first.status !== 402) return { response: first }
  const challenge = readChallenge(first)
  if (!challenge) throw new Error('402 without a valid BRC-121 challenge (x-bsv-sats, x-bsv-server)')
  const { amount, server } = challenge

  // 2. What does it buy? The quote must announce the same price as the 402
  const method = (init.method ?? 'GET').toUpperCase()
  const quote = await fetchQuote(url, method, bodyText(init))
  if (quote && quote.sats !== amount) throw new Error(`The merchant's quote (${quote.sats} sats) does not match its payment request (${amount} sats): not paid`)

  if (opts.maxSats !== undefined && amount > opts.maxSats) {
    throw new Error(`Price ${amount} sats > limit ${opts.maxSats} sats: payment refused`)
  }
  if (opts.beforePay && !(await opts.beforePay({ url, amount, server, order: quote?.order, description: quote?.description }))) {
    throw new Error('Payment refused by beforePay rule')
  }

  const spend = async (): Promise<PayFetchResult> => {
    await opts.beforeSpend?.({ url, amount, server, order: quote?.order, description: quote?.description })
    // 3. BRC-121 payment: output 0 is a BRC-29 payment to the merchant's identity key
    const payment = await constructPaymentHeaders(withHostOriginator(opts.wallet), url, amount, server)
    const txid = Beef.fromBinary(Utils.toArray(payment[BRC121.BEEF], 'base64')).atomicTxid // computed here, not taken from the merchant
    if (!txid) throw new Error('The wallet returned a payment without a transaction id')

    // From here on the money is gone: createAction has already sent the payment. Any failure
    // below is reported WITH the txid, so the caller can book what the wallet really spent.
    const paid = { amount, txid }
    // 4. Same request again, with the payment
    const headers = new Headers(init.headers)
    for (const [k, v] of Object.entries(payment)) headers.set(k, v)
    let second: Response
    try { second = await fetch(url, { ...init, headers }) } catch (e) { throw new PaidNotDelivered(paid, (e as Error).message) }
    // A fresh 402 means the merchant did not accept the payment (invalid, expired or replayed)
    if (second.status === 402) throw new PaidNotDelivered(paid, 'the merchant answered a fresh 402')
    return { response: second, paid }
  }
  return opts.spendLock ? opts.spendLock.run(spend) : spend()
}
