// DEMO market: three fictional shops that get paid by AI agents,
// in BSV via HTTP 402, with the seller kit. Each shop describes what it sells (category, items,
// delivery): the buying company's proxy applies its purchase policy before paying.
//
//   GET  /            storefront (for humans: products and latest paid orders)
//   GET  /api         catalog for agents: shops, addresses, prices, examples
//   GET  /api/hotels  availability and prices (free)       POST /api/hotels/book       book (paid)
//   GET  /api/office/products  (gratuit)                     POST /api/office/orders     commander (payant)
//   GET  /api/software/plans   (gratuit)                     POST /api/software/subscribe s'abonner (payant)
import 'dotenv/config'
import express, { Request } from 'express'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { createSeller, type PaidInvoice } from '../shared/seller-kit.js'
import type { OrderInfo } from '../shared/x402.js'
import { explorerTx } from '../shared/network.js'

const PORT = Number(process.env.MARKET_PORT ?? 5080)
const HOST = process.env.MARKET_HOST ?? '127.0.0.1'
const EUR_PER_SAT = Number(process.env.EUR_PER_SAT ?? 0.01) // same fictional rate as the proxy (testnet)
const PUBLIC_URL = (process.env.MARKET_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '')

// Shop secret: created on first start (it derives the address of each invoice)
let SECRET = process.env.MARKET_SECRET ?? ''
if (SECRET.length < 16) {
  SECRET = randomBytes(24).toString('base64url')
  appendFileSync('.env', `\nMARKET_SECRET=${SECRET}\n`)
  console.log('Market secret created and saved in .env')
}

// ---------------------------------------------------------------------------
// Catalogues (fictifs)
// ---------------------------------------------------------------------------
const HOTELS: Record<string, { name: string; city: string; rooms: Record<string, { name: string; sats: number }> }> = {
  alpenblick: { name: 'Hotel Alpenblick', city: 'München', rooms: { standard: { name: 'Standard room', sats: 12000 }, suite: { name: 'Suite', sats: 30000 } } },
  citylodge: { name: 'City Lodge München', city: 'München', rooms: { standard: { name: 'Compact room', sats: 8900 } } },
  isar: { name: 'Grand Hotel Isar', city: 'München', rooms: { deluxe: { name: 'Deluxe room', sats: 22000 } } }
}
const PRODUCTS: Record<string, { name: string; sats: number }> = {
  pens: { name: 'Pack of 10 pens', sats: 500 },
  notebook: { name: 'A5 notebook', sats: 400 },
  badges: { name: 'Name badge', sats: 300 },
  flyers: { name: '100 printed flyers', sats: 2500 },
  chair: { name: 'Office chair', sats: 18000 },
  monitor: { name: '27" monitor', sats: 25000 }
}
const PLANS: Record<string, { name: string; satsPerSeat: number }> = {
  notes: { name: 'CloudNotes Team', satsPerSeat: 900 },
  crm: { name: 'SalesDesk CRM Pro', satsPerSeat: 4900 }
}
const MERCHANTS = { office: 'Bürobedarf Weber', software: 'CloudSoft Store' }
const eur = (sats: number) => `€${(sats * EUR_PER_SAT).toFixed(2)}`

// ---------------------------------------------------------------------------
// Paid orders (for the storefront and confirmations)
// ---------------------------------------------------------------------------
interface Sale {
  id: string; ts: string; merchant: string; category: string; summary: string; sats: number; txid: string
  method?: 'bsv' | 'card'          // how it was paid
  authId?: string; last4?: string  // card payments: authorization id and last digits (never the full number)
  checkIn?: string                 // hotel: check-in date (for the cancellation terms)
  paid?: PaidInvoice               // what is needed to refund
  status?: 'paid' | 'cancelled'
  refundTxid?: string; refundSats?: number
}
const SALES_FILE = 'data/market-sales.json'
const sales: Sale[] = existsSync(SALES_FILE) ? JSON.parse(readFileSync(SALES_FILE, 'utf8')) : []
const saveSales = () => {
  mkdirSync('data', { recursive: true })
  writeFileSync(`${SALES_FILE}.tmp`, JSON.stringify(sales.slice(-200), null, 2))
  renameSync(`${SALES_FILE}.tmp`, SALES_FILE)
}

const seller = createSeller({
  secret: SECRET,
  skipBroadcast: process.env.MARKET_SKIP_BROADCAST === '1',
  log: m => console.log(`[market] ${m}`),
  onPaid: (inv, txid, req) => {
    const order = inv.order ? (JSON.parse(inv.order) as OrderInfo) : undefined
    const id = `${(order?.category ?? 'X').split('.')[0].slice(0, 2).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`
    sales.push({
      id, ts: new Date().toISOString(), merchant: order?.merchant ?? 'Market', category: order?.category ?? '',
      summary: order ? order.items.map(i => `${i.quantity}× ${i.name}`).join(', ') : inv.resource, sats: inv.amount, txid,
      checkIn: order?.category === 'travel.hotel' ? String(req.body?.checkIn ?? '') : undefined,
      paid: seller.paidRecord(inv), status: 'paid'
    })
    saveSales()
    req.res!.locals.saleId = id
  }
})

// ---------------------------------------------------------------------------
// Prices and orders, computed from the request
// ---------------------------------------------------------------------------
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })
function hotelQuote(b: any): { amount: number; order: OrderInfo } | { error: string } {
  const hotel = HOTELS[String(b?.hotel ?? '')]
  if (!hotel) return { error: `Unknown hotel. Choose: ${Object.keys(HOTELS).join(', ')} (see GET /api/hotels)` }
  const room = hotel.rooms[String(b?.room ?? Object.keys(hotel.rooms)[0])]
  if (!room) return { error: `Unknown room for ${hotel.name}. Choose: ${Object.keys(hotel.rooms).join(', ')}` }
  const nights = Number(b?.nights ?? 1)
  if (!Number.isInteger(nights) || nights < 1 || nights > 14) return { error: 'nights must be between 1 and 14' }
  const checkIn = String(b?.checkIn ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || checkIn < today()) return { error: 'checkIn must be a date (YYYY-MM-DD), today or later' }
  const guest = String(b?.guest ?? '').trim()
  if (guest.length < 2) return { error: 'guest (name of the traveller) is required' }
  return {
    amount: room.sats * nights,
    order: { merchant: hotel.name, category: 'travel.hotel', items: [{ name: `${room.name}, from ${checkIn}`, quantity: nights, unitPriceSats: room.sats, unit: 'night' }] }
  }
}
function officeQuote(b: any): { amount: number; order: OrderInfo } | { error: string } {
  const lines = Array.isArray(b?.items) ? b.items : []
  if (!lines.length || lines.length > 20) return { error: 'items is required, e.g. [{"sku": "pens", "quantity": 2}] (see GET /api/office/products)' }
  const items = []
  for (const l of lines) {
    const p = PRODUCTS[String(l?.sku)]
    const q = Number(l?.quantity ?? 1)
    if (!p) return { error: `Unknown product ${l?.sku}. Choose: ${Object.keys(PRODUCTS).join(', ')}` }
    if (!Number.isInteger(q) || q < 1 || q > 500) return { error: 'quantity must be between 1 and 500' }
    items.push({ name: p.name, quantity: q, unitPriceSats: p.sats, unit: 'item' })
  }
  const a = b?.shipTo
  if (!a?.street || !a?.postalCode || !a?.city || !a?.country) return { error: 'shipTo needs street, postalCode, city and country (2 letters)' }
  const shipTo = { ...(a.name ? { name: String(a.name).slice(0, 80) } : {}), street: String(a.street).slice(0, 120), postalCode: String(a.postalCode).slice(0, 12), city: String(a.city).slice(0, 80), country: String(a.country).slice(0, 2).toUpperCase() }
  return { amount: items.reduce((s, i) => s + i.quantity * i.unitPriceSats, 0), order: { merchant: MERCHANTS.office, category: 'office.supplies', items, shipTo } }
}
function softwareQuote(b: any): { amount: number; order: OrderInfo } | { error: string } {
  const plan = PLANS[String(b?.plan ?? '')]
  if (!plan) return { error: `Unknown plan. Choose: ${Object.keys(PLANS).join(', ')} (see GET /api/software/plans)` }
  const seats = Number(b?.seats ?? 1)
  if (!Number.isInteger(seats) || seats < 1 || seats > 100) return { error: 'seats must be between 1 and 100' }
  return { amount: plan.satsPerSeat * seats, order: { merchant: MERCHANTS.software, category: 'software.subscription', items: [{ name: `${plan.name}, 1 month`, quantity: seats, unitPriceSats: plan.satsPerSeat, unit: 'seat' }] } }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const app = express()
app.set('trust proxy', 'loopback')
app.use(express.json({ limit: '100kb' }))
const base = (req: Request) => (process.env.MARKET_PUBLIC_URL ? PUBLIC_URL : `${req.protocol}://${req.get('host')}`)

// ---------------------------------------------------------------------------
// Card checkout: the same shops also accept a card ("card": {number, cvc, expMonth, expYear} in the body).
// The charge goes to the (simulated) card network, which asks the card issuer — AgentGetPay — in real time.
// ---------------------------------------------------------------------------
const CARD_NETWORK_URL = (process.env.CARD_NETWORK_URL ?? 'http://127.0.0.1:5050').replace(/\/$/, '')
type Quote = (b: any) => { amount: number; order: OrderInfo } | { error: string }
function cardCheckout(quote: Quote, mcc: string): express.RequestHandler {
  return async (req, res, next) => {
    const card = req.body?.card
    if (!card) return next() // no card: the BSV (402) flow handles it
    const q = quote(req.body)
    if ('error' in q) return void res.status(400).json({ error: q.error })
    const key = process.env.CARD_NETWORK_KEY
    if (!key) return void res.status(503).json({ error: 'Card payments are not available here' })
    const number = String(card.number ?? '').replace(/\s/g, '')
    const r = await fetch(`${CARD_NETWORK_URL}/v1/card-network/authorize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Network-Key': key },
      body: JSON.stringify({
        number, cvc: String(card.cvc ?? ''), expMonth: Number(card.expMonth), expYear: Number(card.expYear),
        amountCents: Math.round(q.amount * EUR_PER_SAT * 100), currency: 'EUR',
        merchantName: q.order.merchant, merchantDomain: new URL(base(req)).hostname, mcc
      }),
      signal: AbortSignal.timeout(10_000)
    }).then(x => x.json() as Promise<{ approved?: boolean; reason?: string; authId?: string }>).catch(() => ({ approved: false, reason: 'card network unreachable' } as { approved?: boolean; reason?: string; authId?: string }))
    // 403, not 402: in this protocol 402 means "pay with BSV"
    if (!r.approved) return void res.status(403).json({ error: `Card declined: ${r.reason}` })
    const id = `${q.order.category.split('.')[0].slice(0, 2).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`
    sales.push({
      id, ts: new Date().toISOString(), merchant: q.order.merchant, category: q.order.category,
      summary: q.order.items.map(i => `${i.quantity}× ${i.name}`).join(', '), sats: q.amount, txid: '',
      method: 'card', authId: r.authId, last4: number.slice(-4), status: 'paid',
      checkIn: q.order.category === 'travel.hotel' ? String(req.body?.checkIn ?? '') : undefined
    })
    saveSales()
    console.log(`[market] Card payment ${eur(q.amount)} for ${q.order.merchant} — ${r.authId}`)
    res.locals.saleId = id
    res.locals.payment = { authId: r.authId, method: 'card' }
    res.locals.paidByCard = true
    next()
  }
}
// Runs the BSV (402) payment unless the order was already paid by card
const unlessCard = (mw: express.RequestHandler): express.RequestHandler => (req, res, next) => (res.locals.paidByCard ? next() : mw(req, res, next))

app.get('/api', (req, res) => {
  const b = base(req)
  res.json({
    name: 'Demo marketplace for AI agents (fictional shops)',
    payment: 'HTTP 402 (x402 / BRC-166), paid in BSV testnet. Each paid offer describes the order (merchant, category, items, delivery) in extensions.order. Cards are accepted too: add "card": {"number", "cvc", "expMonth", "expYear"} to the order body.',
    merchantCodes: { hotels: 'MCC 7011', office: 'MCC 5943', software: 'MCC 5734' },
    shops: [
      {
        name: 'Hotels in München', category: 'travel.hotel',
        search: `GET ${b}/api/hotels?checkIn=YYYY-MM-DD&nights=2 (free: availability and prices)`,
        book: `POST ${b}/api/hotels/book`, body: { hotel: 'alpenblick', room: 'standard', checkIn: today(), nights: 2, guest: 'Name of the traveller' }
      },
      {
        name: MERCHANTS.office, category: 'office.supplies',
        products: `GET ${b}/api/office/products (free)`,
        order: `POST ${b}/api/office/orders`, body: { items: [{ sku: 'pens', quantity: 2 }], shipTo: { street: '…', postalCode: '…', city: '…', country: 'DE' } },
        note: 'Ship to the company address given by check_budget.'
      },
      {
        name: MERCHANTS.software, category: 'software.subscription',
        plans: `GET ${b}/api/software/plans (free)`,
        subscribe: `POST ${b}/api/software/subscribe`, body: { plan: 'notes', seats: 3 },
        note: 'Monthly subscription: ask your company for a standing approval (mandate) so renewals do not wait for a human.'
      }
    ],
    cancel: { request: `POST ${b}/api/cancel`, body: { order: 'TR-XXXXXX' }, rules: 'Hotels: free until the day before check-in. Office supplies: within 1 hour. Subscriptions: not refunded. The refund is paid back in BSV to the buyer.' }
  })
})

app.get('/api/hotels', (req, res) => {
  const nights = Math.min(14, Math.max(1, Number(req.query.nights ?? 1) || 1))
  res.json({
    city: 'München', checkIn: req.query.checkIn ?? today(), nights,
    offers: Object.entries(HOTELS).flatMap(([hotel, h]) => Object.entries(h.rooms).map(([room, r]) => ({
      hotel, room, name: `${h.name}, ${r.name}`, pricePerNightSats: r.sats, pricePerNightEur: +(r.sats * EUR_PER_SAT).toFixed(2),
      totalSats: r.sats * nights, totalEur: +(r.sats * nights * EUR_PER_SAT).toFixed(2)
    })))
  })
})
app.get('/api/office/products', (_req, res) => res.json(Object.entries(PRODUCTS).map(([sku, p]) => ({ sku, name: p.name, priceSats: p.sats, priceEur: +(p.sats * EUR_PER_SAT).toFixed(2) }))))
app.get('/api/software/plans', (_req, res) => res.json(Object.entries(PLANS).map(([plan, p]) => ({ plan, name: p.name, pricePerSeatPerMonthSats: p.satsPerSeat, pricePerSeatPerMonthEur: +(p.satsPerSeat * EUR_PER_SAT).toFixed(2) }))))

app.post('/api/hotels/book', cardCheckout(hotelQuote, '7011'), unlessCard(seller.requirePayment(req => hotelQuote(req.body), 'Hotel booking')), (req, res) => {
  const q = hotelQuote(req.body) as { order: OrderInfo }
  res.json({
    confirmation: res.locals.saleId ?? 'already confirmed', hotel: q.order.merchant, guest: req.body.guest, checkIn: req.body.checkIn, nights: req.body.nights ?? 1, txid: res.locals.payment?.txid,
    cancellation: `Free cancellation until the day before check-in: POST ${base(req)}/api/cancel with {"order": "${res.locals.saleId ?? '…'}"}`
  })
})
app.post('/api/office/orders', cardCheckout(officeQuote, '5943'), unlessCard(seller.requirePayment(req => officeQuote(req.body), 'Office supplies order')), (req, res) => {
  res.json({
    order: res.locals.saleId ?? 'already confirmed', delivery: '2–3 business days', txid: res.locals.payment?.txid,
    cancellation: `Can be cancelled within 1 hour: POST ${base(req)}/api/cancel with {"order": "${res.locals.saleId ?? '…'}"}`
  })
})
app.post('/api/software/subscribe', cardCheckout(softwareQuote, '5734'), unlessCard(seller.requirePayment(req => softwareQuote(req.body), 'Software subscription (1 month)')), (req, res) => {
  res.json({ subscription: res.locals.saleId ?? 'already confirmed', plan: req.body.plan, seats: req.body.seats ?? 1, period: '1 month', txid: res.locals.payment?.txid })
})

// Cancellation with a refund in BSV (PAYMENT-REFUND header: the buyer's proxy verifies and records it)
//   hotel: free until the day before check-in · office supplies: within 1 hour · subscription: no refund
app.post('/api/cancel', async (req, res) => {
  const sale = sales.find(x => x.id === String(req.body?.order ?? '').trim().toUpperCase())
  if (!sale) return res.status(404).json({ error: 'Unknown order' })
  if (sale.status === 'cancelled') return res.status(409).json({ error: 'This order is already cancelled', refundTxid: sale.refundTxid })
  if (sale.category === 'travel.hotel' && !(sale.checkIn && sale.checkIn > today())) return res.status(409).json({ error: 'Too late: free cancellation ends the day before check-in' })
  if (sale.category === 'office.supplies' && Date.now() - Date.parse(sale.ts) > 3600_000) return res.status(409).json({ error: 'Too late: the order has been shipped (cancellation within 1 hour only)' })
  if (sale.category.startsWith('software')) return res.status(409).json({ error: 'Subscriptions are not refunded; they simply end after the paid month' })
  if (sale.method === 'card') return res.status(409).json({ error: 'Card payments are refunded through the card network (not part of this demo)' })
  if (!sale.paid) return res.status(409).json({ error: 'This order cannot be refunded automatically' })
  try {
    const notice = await seller.refund(sale.paid)
    Object.assign(sale, { status: 'cancelled', refundTxid: notice.refundTxid, refundSats: notice.sats })
    saveSales()
    res.set('PAYMENT-REFUND', seller.refundHeader(notice)).json({ cancelled: sale.id, refundSats: notice.sats, refundEur: +(notice.sats * EUR_PER_SAT).toFixed(2), refundTxid: notice.refundTxid })
  } catch (e) {
    res.status(500).json({ error: `Refund failed: ${(e as Error).message}` })
  }
})

// ---------------------------------------------------------------------------
// Storefront (for humans and the jury)
// ---------------------------------------------------------------------------
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
app.get('/', (req, res) => {
  const recent = [...sales].reverse().slice(0, 15)
  const card = (title: string, cat: string, rows: string[]) => `<section class="card"><div class="shop">${esc(title)}<span>${esc(cat)}</span></div><ul>${rows.join('')}</ul></section>`
  const row = (name: string, sats: number, unit = '') => `<li><span>${esc(name)}</span><b>${eur(sats)}${unit}</b></li>`
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo Market · AgentGetPay</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#16181d; --muted:#6b7280; --line:#e5e7eb; --accent:#2f4fd8; --tag:#eef1fb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#171a21; --text:#eceef2; --muted:#9aa1ad; --line:#262b35; --accent:#8ea2ff; --tag:#1d2333; } }
  * { box-sizing: border-box; } body { margin:0; font:15px/1.5 -apple-system,"Segoe UI",Inter,sans-serif; background:var(--bg); color:var(--text); }
  main { max-width:1100px; margin:0 auto; padding:28px 16px 60px; }
  h1 { font-size:22px; margin:0; } h1 small { display:block; font-size:13px; font-weight:400; color:var(--muted); }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:28px 0 10px; }
  .note { margin:14px 0 0; padding:10px 14px; border-radius:10px; background:var(--tag); font-size:14px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr)); gap:12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; }
  .shop { font-weight:650; display:flex; justify-content:space-between; gap:8px; } .shop span { font-weight:500; font-size:12px; color:var(--accent); background:var(--tag); padding:2px 8px; border-radius:999px; }
  ul { list-style:none; padding:0; margin:10px 0 0; } li { display:flex; justify-content:space-between; gap:8px; padding:5px 0; border-top:1px solid var(--line); font-size:14px; }
  li b { font-variant-numeric:tabular-nums; white-space:nowrap; }
  table { width:100%; border-collapse:collapse; } th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); font-size:14px; vertical-align:top; }
  th { color:var(--muted); font-weight:500; font-size:12px; text-transform:uppercase; } td.num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .wrap { overflow-x:auto; padding:0; } .muted { color:var(--muted); } a { color:var(--accent); text-decoration:none; } code { font-size:13px; }
</style></head><body><main>
<h1>Demo Market<small>Fictional shops that AI agents can buy from · paid in BSV testnet via HTTP 402, or by virtual card</small></h1>
<p class="note">Agents find the catalog at <code>${esc(base(req))}/api</code>. Every paid offer tells the buyer's proxy what is sold (category, unit prices, delivery address), so the company's purchase policy can be applied before paying.</p>
<h2>Shops</h2>
<div class="grid">
${card('Hotels in München', 'travel.hotel', Object.values(HOTELS).flatMap(h => Object.values(h.rooms).map(r => row(`${h.name} · ${r.name}`, r.sats, ' / night'))))}
${card(MERCHANTS.office, 'office.supplies', Object.values(PRODUCTS).map(p => row(p.name, p.sats)))}
${card(MERCHANTS.software, 'software.subscription', Object.values(PLANS).map(p => row(p.name, p.satsPerSeat, ' / seat / month')))}
</div>
<h2>Latest orders paid by agents</h2>
<section class="card wrap"><table><thead><tr><th>Time</th><th>Order</th><th>Shop</th><th>What</th><th class="num">Amount</th><th>Payment</th></tr></thead><tbody>
${recent.map(s => `<tr><td class="muted">${new Date(s.ts).toLocaleString('en-GB', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' })}</td><td>${esc(s.id)}</td><td>${esc(s.merchant)}</td><td class="muted">${esc(s.summary)}</td><td class="num">${eur(s.sats)}</td><td>${s.method === 'card' ? `<span class="muted">Card •••• ${esc(s.last4)}</span>` : `<a href="${explorerTx(esc(s.txid))}" rel="noopener" target="_blank">${esc(s.txid.slice(0, 10))}…</a>`}${s.status === 'cancelled' && s.refundTxid ? `<br><span class="muted">Cancelled · refund </span><a href="${explorerTx(esc(s.refundTxid))}" rel="noopener" target="_blank">${esc(s.refundTxid.slice(0, 10))}…</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No order yet.</td></tr>'}
</tbody></table></section>
</main></body></html>`)
})

app.listen(PORT, HOST, () => console.log(`Demo market on http://localhost:${PORT} — catalog for agents: /api`))
