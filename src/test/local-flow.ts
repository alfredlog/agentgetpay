// Offline test of BRC-121 end to end, in one process: wallet-toolbox's mock chain, a merchant
// wallet behind the seller kit, an agent (payer) wallet behind payFetch, and a BRC-29 refund.
import express from 'express'
import type { Server } from 'node:http'
import { openMockChain } from './helpers/mockchain.js'
import { createSeller, type PaidOrder, type RefundNotice } from '../shared/seller-kit.js'
import { payFetch } from '../agent/pay-fetch.js'
import { acceptBrc29Payment } from '../shared/payments.js'
import { constructPaymentHeaders, withHostOriginator } from '../shared/brc121.js'
import { spendableSats } from '../shared/wallet.js'
import { QUOTE_PATH } from '../shared/order.js'

let failures = 0
const check = (ok: boolean, label: string) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) failures++ }

const chain = await openMockChain()
const merchant = await chain.makeWallet()
const payer = await chain.makeWallet()
await chain.fund(payer, 200_000)
const merchantKey = (await merchant.getPublicKey({ identityKey: true })).publicKey
const payerKey = (await payer.getPublicKey({ identityKey: true })).publicKey

let lastPaid: PaidOrder | undefined
const seller = createSeller({ wallet: merchant, log: () => {}, onPaid: p => { lastPaid = p } })
const app = express()
app.use(express.json())
app.post(QUOTE_PATH, seller.quote)
app.get('/api/quote', seller.requirePayment('GET /api/quote', 100, 'Quote of the day'), (_req, res) => res.json({ quote: 'paid content' }))
app.post('/api/book', seller.requirePayment('POST /api/book', b => Number.isInteger(b?.nights) && b.nights > 0
  ? { amount: 1200 * b.nights, order: { merchant: 'Hotel Test', category: 'travel.hotel', items: [{ name: 'Room', quantity: b.nights, unitPriceSats: 1200, unit: 'night' }] } }
  : { error: 'nights required' }, 'Hotel booking'), (_req, res) => res.json({ booked: true }))
let refund: RefundNotice | undefined
app.post('/api/cancel', async (_req, res) => { refund = await seller.refund(lastPaid!); res.json({ cancelled: true, refund }) })
const server: Server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

try {
  // 1. The 402 challenge is BRC-121: price and merchant identity key, nothing else
  const raw = await fetch(`${base}/api/quote`)
  check(raw.status === 402 && raw.headers.get('x-bsv-sats') === '100' && raw.headers.get('x-bsv-server') === merchantKey, '402 carries x-bsv-sats and x-bsv-server')
  check(!raw.headers.get('payment-required') && !raw.headers.get('payment-response'), 'No old x402 headers')

  // 2. The free quote gives the order details BEFORE payment
  const body = JSON.stringify({ nights: 2 })
  let offer: any
  const before = await spendableSats(merchant)
  const r = await payFetch(`${base}/api/book`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, {
    wallet: payer, beforePay: async o => { offer = o; return true }
  })
  check(offer?.amount === 2400 && offer?.server === merchantKey && offer?.order?.category === 'travel.hotel' && offer?.order?.items?.[0]?.quantity === 2, 'beforePay sees price, merchant key and the order (from the quote)')
  check(r.response.status === 200 && r.paid?.amount === 2400 && (await r.response.json()).booked === true, 'Paid and served')
  check(await spendableSats(merchant) === before + 2400, 'The merchant wallet is credited at once (internalizeAction)')
  check(lastPaid?.txid === r.paid?.txid && lastPaid?.payer === payerKey, 'The merchant knows the txid and the buyer\'s identity key')

  // 3. A refused policy pays nothing
  const payerBefore = await spendableSats(payer)
  const refused = await payFetch(`${base}/api/quote`, {}, { wallet: payer, beforePay: async () => false }).catch(e => e as Error)
  check(refused instanceof Error && await spendableSats(payer) === payerBefore, 'beforePay = false: nothing is signed or spent')

  // 4. Replaying the same payment headers gets a fresh 402
  const headers = await constructPaymentHeaders(withHostOriginator(payer), `${base}/api/quote`, 100, merchantKey) as unknown as Record<string, string>
  const once = await fetch(`${base}/api/quote`, { headers })
  const twice = await fetch(`${base}/api/quote`, { headers })
  check(once.status === 200 && twice.status === 402, 'Replay refused (fresh 402)')

  // 5. Refund: BRC-29 to the buyer's identity key, verified and internalized by the buyer
  const c = await fetch(`${base}/api/cancel`, { method: 'POST' }).then(x => x.json()) as { refund: RefundNotice }
  check(c.refund?.satoshis === 100 && c.refund.senderIdentityKey === merchantKey, 'The cancel answer carries a BRC-29 refund from the merchant')
  const payerMid = await spendableSats(payer)
  await acceptBrc29Payment(payer, c.refund, chain.chainTracker, 'Refund')
  check(await spendableSats(payer) === payerMid + 100, 'The buyer verifies (SPV) and internalizes the refund')
  const stranger = await chain.makeWallet()
  const stolen = await acceptBrc29Payment(stranger, refund!).then(() => false, () => true)
  check(stolen, 'Another wallet cannot accept the refund')
} catch (e) {
  console.error(e); failures++
} finally {
  server.close()
  await chain.close()
}
console.log(failures ? `\n${failures} failure(s)` : '\nAll BRC-121 checks passed')
process.exit(failures ? 1 : 0)
