// The SELLER: an API that gets paid by agents via HTTP 402 (BRC-121, @bsv/402-pay).
// In the final demo, this role is played by PDF Libre.
import 'dotenv/config'
import express from 'express'
import { randomBytes } from 'node:crypto'
import { createSeller } from '../shared/seller-kit.js'
import { QUOTE_PATH } from '../shared/order.js'
import { Hash, Utils } from '../shared/bsv.js'
import { openServerWallet } from '../shared/wallet.js'

const PORT = Number(process.env.SELLER_PORT ?? 4000)
const SECRET = process.env.SELLER_SECRET
if (!SECRET) throw new Error('SELLER_SECRET missing in .env (run npm run wallet)')
// The secret derives the root key of the seller's wallet-toolbox wallet (it receives the payments)
const wallet = await openServerWallet({
  rootKeyHex: Utils.toHex(Hash.sha256(Utils.toArray(`agentgetpay-seller-wallet:${SECRET}`, 'utf8'))),
  filePath: process.env.SELLER_WALLET_FILE ?? 'data/seller-wallet.sqlite',
  databaseName: 'seller_wallet'
})
const seller = createSeller({ wallet })
const requirePayment = seller.requirePayment

const app = express()
app.use(express.json())
app.post(QUOTE_PATH, seller.quote) // free quotes: price and order details before payment

// A paid resource: 10 satoshis per call
app.get('/api/quote', requirePayment('GET /api/quote', 10, 'Quote of the day'), (_req, res) => {
  res.json({ quote: 'The best time to plant a tree was 20 years ago. The second best time is now.' })
})

// Two more expensive resources, to test the proxy's rules
app.get('/api/analysis', requirePayment('GET /api/analysis', 18, 'Market analysis'), (_req, res) => {
  res.json({ analysis: 'The market for AI agent payments is growing fast.' })
})
app.get('/api/report', requirePayment('GET /api/report', 30, 'Full report'), (_req, res) => {
  res.json({ report: 'Full 40-page report (simulated).' })
})

// ---------------------------------------------------------------------------
// Demo shops (fictional): the merchant DESCRIBES what it sells in its free quote,
// so the buyer's proxy can apply its purchase policy (category, unit price, delivery).
// ---------------------------------------------------------------------------
const ROOMS: Record<string, { name: string; sats: number }> = {
  standard: { name: 'Standard room', sats: 12000 },
  suite: { name: 'Suite', sats: 30000 }
}
app.post('/api/hotel/book', requirePayment('POST /api/hotel/book', body => {
  const room = ROOMS[String(body?.room ?? 'standard')]
  const nights = Number(body?.nights ?? 1)
  if (!room) return { error: `Unknown room. Choose: ${Object.keys(ROOMS).join(', ')}` }
  if (!Number.isInteger(nights) || nights < 1 || nights > 30) return { error: 'nights must be between 1 and 30' }
  return { amount: room.sats * nights, order: { merchant: 'Hotel Alpenblick (demo)', category: 'travel.hotel', items: [{ name: room.name, quantity: nights, unitPriceSats: room.sats, unit: 'night' }] } }
}, 'Hotel booking'), (req, res) => {
  res.json({ confirmation: `HA-${randomBytes(3).toString('hex').toUpperCase()}`, room: req.body?.room ?? 'standard', nights: req.body?.nights ?? 1 })
})

const PRODUCTS: Record<string, { name: string; sats: number }> = {
  pens: { name: 'Pack of 10 pens', sats: 500 },
  badges: { name: 'Name badge', sats: 300 },
  monitor: { name: '27" monitor', sats: 25000 }
}
app.post('/api/office/order', requirePayment('POST /api/office/order', body => {
  const lines = Array.isArray(body?.items) ? body.items : []
  if (!lines.length) return { error: 'items is required, e.g. [{"sku": "pens", "quantity": 2}]' }
  const items = []
  for (const l of lines) {
    const p = PRODUCTS[String(l?.sku)]
    const q = Number(l?.quantity ?? 1)
    if (!p) return { error: `Unknown product ${l?.sku}. Choose: ${Object.keys(PRODUCTS).join(', ')}` }
    if (!Number.isInteger(q) || q < 1 || q > 1000) return { error: 'quantity must be between 1 and 1000' }
    items.push({ name: p.name, quantity: q, unitPriceSats: p.sats, unit: 'item' })
  }
  const a = body?.shipTo
  if (!a?.street || !a?.postalCode || !a?.city || !a?.country) return { error: 'shipTo needs street, postalCode, city and country' }
  const shipTo = { ...(a.name ? { name: String(a.name) } : {}), street: String(a.street), postalCode: String(a.postalCode), city: String(a.city), country: String(a.country).toUpperCase() }
  return { amount: items.reduce((s, i) => s + i.quantity * i.unitPriceSats, 0), order: { merchant: 'Bürobedarf Weber (demo)', category: 'office.supplies', items, shipTo } }
}, 'Office supplies order'), (_req, res) => {
  res.json({ order: `BW-${randomBytes(3).toString('hex').toUpperCase()}`, delivery: '2–3 business days' })
})

app.post('/api/software/subscribe', requirePayment('POST /api/software/subscribe', () => ({
  amount: 1900,
  order: { merchant: 'CloudNotes (demo)', category: 'software.subscription', items: [{ name: 'CloudNotes Team, 1 month', quantity: 1, unitPriceSats: 1900, unit: 'month' }] }
}), 'Software subscription'), (_req, res) => {
  res.json({ subscription: `CN-${randomBytes(3).toString('hex').toUpperCase()}`, period: '1 month' })
})

// Only on this computer by default (SELLER_HOST=0.0.0.0 to open it to the network)
app.listen(PORT, process.env.SELLER_HOST ?? '127.0.0.1', () => console.log(`Seller ready on http://localhost:${PORT} — /api/quote (10 sats), /api/analysis (18), /api/report (30), demo shops: /api/hotel/book, /api/office/order, /api/software/subscribe`))
