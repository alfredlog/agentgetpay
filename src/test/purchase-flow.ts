// Test of the purchase policy: daily/monthly budgets, categories, price per unit, delivery addresses.
// Fake wallet, fake blockchain, demo shops: nothing is paid, nothing on your machine is touched.
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { PrivateKey } from '../shared/bsv.js'
import { prepareMockChain } from './helpers/mockchain.js'

const PROXY_PORT = 5350, SELLER_PORT = 5390
const PROXY = `http://127.0.0.1:${PROXY_PORT}`, SHOP = `http://localhost:${SELLER_PORT}`
const ADMIN = 'test-admin-password-123'
const root = resolve('.')
const dir = mkdtempSync(join(tmpdir(), 'agentgetpay-purchase-'))
cpSync(join(root, 'config'), join(dir, 'config'), { recursive: true })
writeFileSync(join(dir, '.env'), `BSV_WIF=${PrivateKey.fromRandom().toWif()}\nADMIN_TOKEN=${ADMIN}\nSELLER_SECRET=test-seller-secret\n`)
// Shared offline chain (wallet-toolbox mock chain) for every process started below
process.env.MOCK_CHAIN_DB = join(dir, 'chain.sqlite')
await prepareMockChain(process.env.MOCK_CHAIN_DB)

const tsx = createRequire(import.meta.url).resolve('tsx/cli')
const procs: ChildProcess[] = []
const start = (file: string, env: Record<string, string>) => {
  const p = spawn(process.execPath, [tsx, join(root, file)], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
  p.stderr!.on('data', d => { if (/error/i.test(String(d))) process.stderr.write(d) })
  procs.push(p)
  return p
}
const startProxy = () => start('src/test/proxy-flow.ts', { PROXY_PORT: String(PROXY_PORT), TELEGRAM_BOT_TOKEN: '', APPROVAL_AUTO: 'approved' })
start('src/seller/server.ts', { SELLER_PORT: String(SELLER_PORT) })
let proxy = startProxy()

let failures = 0
const check = (ok: boolean, label: string) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) failures++ }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const waitUp = async () => { for (let i = 0; i < 80; i++) { if (await fetch(`${PROXY}/v1/stats`).then(() => fetch(`${SHOP}/api/quote`)).then(() => true, () => false)) return; await sleep(250) } }
const admin = (path: string, method = 'GET', body?: unknown) => fetch(`${PROXY}/v1/admin${path}`, {
  method, headers: { 'X-Admin-Token': ADMIN, 'X-Admin-Name': 'Test admin', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
}).then(r => r.json())
let key = ''
const buy = (path: string, body: unknown, purpose = 'Test purchase') => fetch(`${PROXY}/v1/fetch`, {
  method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: `${SHOP}${path}`, method: 'POST', body, purpose })
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) as any }))

const company = { street: 'Leopoldstraße 1', postalCode: '80802', city: 'München', country: 'DE' }
const rules = {
  daily_budget_eur: 400, monthly_budget_eur: 500, max_per_payment_eur: 400, approval_above_eur: 1000,
  allowed_domains: 'localhost',
  categories: { travel: { max_unit_price_eur: 150, monthly_budget_eur: 300 }, 'office.supplies': { max_unit_price_eur: 50 } },
  shipping_addresses: [company]
}

try {
  await waitUp()
  const created = await admin('/agents', 'POST', { id: 'einkauf-test', rules })
  key = created.apiKey
  check(!!key, 'Purchasing agent created with categories, monthly budget and a delivery address')
  const bad = await admin('/agents/einkauf-test', 'PUT', { rules: { ...rules, monthly_budget_eur: 100 } })
  check(/monthly budget cannot be lower/i.test(bad.error ?? ''), 'Admin cannot set a monthly budget below the daily budget')

  // Hotel
  let r = await buy('/api/hotel/book', { room: 'standard', nights: 2 }, 'Hotel for the TBC26 fair')
  check(r.status === 200 && /^HA-/.test(r.json.confirmation), 'Hotel: 2 nights at €120 are booked')
  r = await buy('/api/hotel/book', { room: 'suite', nights: 1 })
  check(r.status === 403 && /€300\.00 per night exceeds the travel limit \(€150\.00\)/.test(r.json.reason), `Hotel: suite at €300/night refused (${r.json.reason})`)
  r = await buy('/api/hotel/book', { room: 'standard', nights: 1 })
  check(r.status === 403 && /Monthly travel budget exceeded/.test(r.json.reason), `Hotel: 3rd night refused, travel budget of €300/month reached (${r.json.reason})`)

  // Office supplies
  r = await buy('/api/office/order', { items: [{ sku: 'pens', quantity: 2 }], shipTo: { street: 'Leopoldstr. 1', postalCode: '80802', city: 'Muenchen', country: 'de' } })
  check(r.status === 200 && /^BW-/.test(r.json.order), 'Office: pens shipped to the company address (written differently) are ordered')
  r = await buy('/api/office/order', { items: [{ sku: 'pens', quantity: 1 }], shipTo: { street: 'Hauptstraße 5', postalCode: '10115', city: 'Berlin', country: 'DE' } })
  check(r.status === 403 && /Delivery address not allowed/.test(r.json.reason), 'Office: delivery to a private address is refused')
  r = await buy('/api/office/order', { items: [{ sku: 'monitor', quantity: 1 }], shipTo: company })
  check(r.status === 403 && /€250\.00 per item exceeds the office.supplies limit/.test(r.json.reason), 'Office: a €250 monitor is refused (max €50 per item)')

  // Category not provided for
  r = await buy('/api/software/subscribe', {})
  check(r.status === 403 && /category not allowed: software.subscription/.test(r.json.reason), 'Software subscription refused: category not allowed for this agent')

  // What the agent sees
  const me = await fetch(`${PROXY}/v1/me`, { headers: { Authorization: `Bearer ${key}` } }).then(x => x.json()) as any
  check(Math.abs(me.spentMonthEur - 250) < 0.001 && Math.abs(me.categories.travel.spentMonthEur - 240) < 0.001, `Agent sees €${me.spentMonthEur} spent this month, €${me.categories?.travel?.spentMonthEur} on travel`)

  // The audit log keeps the order
  const ledger = await fetch(`${PROXY}/v1/ledger`).then(x => x.json()) as any[]
  const hotel = ledger.find(e => e.decision === 'allow' && e.order?.category === 'travel.hotel')
  check(hotel?.order?.merchant === 'Hotel Alpenblick (demo)' && hotel.order.items[0].quantity === 2, 'Audit log records merchant, category and items')
  const change = ledger.find(e => e.decision === 'admin' && /Agent created/.test(e.reason))
  check(!!change, 'Agent creation recorded in the audit log')

  // Restart: monthly and category counters are rebuilt from the audit log
  proxy.kill(); await sleep(500)
  proxy = startProxy(); await waitUp()
  r = await buy('/api/hotel/book', { room: 'standard', nights: 1 })
  check(r.status === 403 && /Monthly travel budget exceeded/.test(r.json.reason), 'After a restart, the monthly travel budget is still enforced')

  // The agent's monthly budget: the dashboard shows it
  const stats = await fetch(`${PROXY}/v1/stats`).then(x => x.json()) as any
  const s = stats.agents.find((a: any) => a.agentId === 'einkauf-test')
  check(s?.monthlyBudgetEur === 500 && Math.abs(s.spentMonthEur - 250) < 0.001, 'Dashboard shows the monthly budget and what was spent')

  // Rules saved on disk
  const saved = JSON.parse(readFileSync(join(dir, 'config/policies.json'), 'utf8'))['einkauf-test']
  check(saved?.categories?.travel?.max_unit_price_eur === 150 && saved.shipping_addresses?.[0]?.city === 'München', 'Rules saved in config/policies.json')
} catch (e) {
  console.error(e); failures++
} finally {
  for (const p of procs) p.kill()
  rmSync(dir, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll purchase-rule checks passed')
process.exit(failures ? 1 : 0)
