// Test of the demo market through the proxy: catalog, hotel, office supplies, subscription, storefront.
// Fake wallet, fake blockchain: nothing is paid, nothing on your machine is touched.
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { PrivateKey } from '../shared/bsv.js'

const PROXY_PORT = 5450, MARKET_PORT = 5480
const PROXY = `http://127.0.0.1:${PROXY_PORT}`, MARKET = `http://localhost:${MARKET_PORT}`
const ADMIN = 'test-admin-password-123'
const root = resolve('.')
const dir = mkdtempSync(join(tmpdir(), 'agentgetpay-market-'))
cpSync(join(root, 'config'), join(dir, 'config'), { recursive: true })
writeFileSync(join(dir, '.env'), `BSV_WIF=${PrivateKey.fromRandom().toWif()}\nADMIN_TOKEN=${ADMIN}\nMARKET_SECRET=test-market-secret-123456\n`)

const tsx = createRequire(import.meta.url).resolve('tsx/cli')
const procs: ChildProcess[] = []
const start = (file: string, env: Record<string, string>) => {
  const p = spawn(process.execPath, [tsx, join(root, file)], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
  p.stderr!.on('data', d => { if (/error/i.test(String(d))) process.stderr.write(d) })
  procs.push(p)
}
start('src/test/proxy-flow.ts', { PROXY_PORT: String(PROXY_PORT), TELEGRAM_BOT_TOKEN: '', APPROVAL_AUTO: 'approved' })
start('src/market/server.ts', { MARKET_PORT: String(MARKET_PORT), MARKET_SKIP_BROADCAST: '1' })

let failures = 0
const check = (ok: boolean, label: string) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) failures++ }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let key = ''
const call = (path: string, body?: unknown, purpose = 'Market test') => fetch(`${PROXY}/v1/fetch`, {
  method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: `${MARKET}${path}`, method: body ? 'POST' : 'GET', body, purpose })
}).then(async r => ({ status: r.status, paid: Number(r.headers.get('X-Paid-Sats') ?? 0), json: await r.json().catch(() => ({})) as any }))
const company = { street: 'Leopoldstraße 1', postalCode: '80802', city: 'München', country: 'DE' }
const checkIn = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)

try {
  for (let i = 0; i < 80; i++) { if (await fetch(`${PROXY}/v1/stats`).then(() => fetch(`${MARKET}/api`)).then(() => true, () => false)) break; await sleep(250) }
  const created = await fetch(`${PROXY}/v1/admin/agents`, {
    method: 'POST', headers: { 'X-Admin-Token': ADMIN, 'X-Admin-Name': 'Test admin', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'einkauf-01', rules: {
      daily_budget_eur: 500, monthly_budget_eur: 1500, max_per_payment_eur: 400, approval_above_eur: 150, allowed_domains: 'localhost',
      categories: { 'travel.hotel': { max_unit_price_eur: 150 }, 'office.supplies': { max_unit_price_eur: 50 }, software: { approval_above_eur: 0 } },
      shipping_addresses: [company]
    } })
  }).then(r => r.json()) as any
  key = created.apiKey

  const cat = await call('/api')
  check(cat.status === 200 && cat.paid === 0 && cat.json.shops?.length === 3, 'Catalog is free and lists 3 shops')
  const offers = await call(`/api/hotels?checkIn=${checkIn}&nights=2`)
  check(offers.json.offers?.length === 4, 'Hotel search returns 4 offers, free')

  let r = await call('/api/hotels/book', { hotel: 'citylodge', room: 'standard', checkIn, nights: 2, guest: 'Alfred M.' }, 'Hotel for the TBC26 fair')
  check(r.status === 200 && r.paid === 17800 && /^TR-/.test(r.json.confirmation), `City Lodge, 2 nights (€178) booked: ${r.json.confirmation}`)
  r = await call('/api/hotels/book', { hotel: 'isar', room: 'deluxe', checkIn, nights: 1, guest: 'Alfred M.' })
  check(r.status === 403 && /€220\.00 per night exceeds the travel.hotel limit/.test(r.json.reason), 'Grand Hotel Isar at €220/night refused by the policy')
  r = await call('/api/hotels/book', { hotel: 'citylodge', checkIn: '2020-01-01', nights: 1, guest: 'Alfred M.' })
  check(r.status === 502 || r.status === 400, `Booking in the past refused by the hotel (${r.status})`)

  r = await call('/api/office/orders', { items: [{ sku: 'badges', quantity: 20 }, { sku: 'flyers', quantity: 2 }], shipTo: company }, 'Badges and flyers for the booth')
  check(r.status === 200 && r.paid === 11000 && /^OF-/.test(r.json.order), `Office order (€110) paid: ${r.json.order}`)
  r = await call('/api/software/subscribe', { plan: 'notes', seats: 3 }, 'Shared notes for the team')
  check(r.status === 200 && /^SO-/.test(r.json.subscription), 'Software subscription paid after approval (category always needs approval)')

  const ledger = await fetch(`${PROXY}/v1/ledger`).then(x => x.json()) as any[]
  const soft = ledger.find(e => e.decision === 'allow' && e.order?.category === 'software.subscription')
  check(soft?.approvedBy === 'test-auto', 'Subscription approval recorded in the audit log')

  const page = await fetch(`${MARKET}/`).then(x => x.text())
  check(/City Lodge München/.test(page) && /2× Compact room/.test(page) && /20× Name badge/.test(page), 'Storefront shows the latest orders paid by agents')
} catch (e) {
  console.error(e); failures++
} finally {
  for (const p of procs) p.kill()
  rmSync(dir, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll market checks passed')
process.exit(failures ? 1 : 0)
