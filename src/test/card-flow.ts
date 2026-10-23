// End-to-end test of the card rail: virtual cards issued under the company rules, charges authorized in real time,
// misuse declined. Fake wallet, fake blockchain, simulated card network, demo market: nothing real is charged.
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { PrivateKey } from '@bsv/sdk'

const PROXY_PORT = 5650, MARKET_PORT = 5680
const PROXY = `http://127.0.0.1:${PROXY_PORT}`, MARKET = `http://localhost:${MARKET_PORT}`
const ADMIN = 'test-admin-password-123', NETWORK_KEY = 'test-card-network-key-123456'
const root = resolve('.')
const dir = mkdtempSync(join(tmpdir(), 'agentgetpay-card-'))
cpSync(join(root, 'config'), join(dir, 'config'), { recursive: true })
writeFileSync(join(dir, '.env'), `BSV_WIF=${PrivateKey.fromRandom().toWif()}\nADMIN_TOKEN=${ADMIN}\nMARKET_SECRET=test-market-secret-123456\nCARD_NETWORK_KEY=${NETWORK_KEY}\n`)

const tsx = createRequire(import.meta.url).resolve('tsx/cli')
const procs: ChildProcess[] = []
const start = (file: string, env: Record<string, string>) => {
  const p = spawn(process.execPath, [tsx, join(root, file)], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
  p.stderr!.on('data', d => { if (/error/i.test(String(d))) process.stderr.write(d) })
  procs.push(p)
}
start('src/test/proxy-flow.ts', { PROXY_PORT: String(PROXY_PORT), TELEGRAM_BOT_TOKEN: '', APPROVAL_AUTO: '' })
start('src/market/server.ts', { MARKET_PORT: String(MARKET_PORT), MARKET_SKIP_BROADCAST: '1', CARD_NETWORK_URL: PROXY })

let failures = 0
const check = (ok: boolean, label: string) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) failures++ }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const adminCall = (path: string, method = 'GET', body?: unknown) => fetch(`${PROXY}${path}`, {
  method, headers: { 'X-Admin-Token': ADMIN, 'X-Admin-Name': 'Alfred', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) as any }))
let key = ''
const agent = (path: string, method = 'GET', body?: unknown) => fetch(`${PROXY}${path}`, {
  method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) as any }))
const cardOf = (c: any) => ({ number: c.number, cvc: c.cvc, expMonth: c.expMonth, expYear: c.expYear })
const shop = (path: string, body: unknown) => agent('/v1/fetch', 'POST', { url: `${MARKET}${path}`, method: 'POST', body, purpose: 'Card test' })
const spent = async () => (await agent('/v1/me')).json.spentEur as number
const company = { street: 'Leopoldstraße 1', postalCode: '80802', city: 'München', country: 'DE' }
const checkIn = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)

try {
  for (let i = 0; i < 80; i++) { if (await fetch(`${PROXY}/v1/stats`).then(() => fetch(`${MARKET}/api`)).then(() => true, () => false)) break; await sleep(250) }
  key = (await adminCall('/v1/admin/agents', 'POST', { id: 'einkauf-01', rules: {
    daily_budget_eur: 600, monthly_budget_eur: 2000, max_per_payment_eur: 400, approval_above_eur: 100, allowed_domains: 'localhost',
    categories: { 'travel.hotel': { max_unit_price_eur: 150 }, 'office.supplies': { max_unit_price_eur: 50 }, software: { approval_above_eur: 0 } },
    shipping_addresses: [company]
  } })).json.apiKey

  // 1. A small card, within policy: issued at once
  let r = await agent('/v1/cards', 'POST', { merchantName: 'Bürobedarf Weber', merchantDomain: 'localhost', category: 'office.supplies', amountEur: 30, items: [{ name: 'Name badge', quantity: 10, unitPriceEur: 3 }], purpose: 'Badges for the booth' })
  const office = r.json.card
  check(r.status === 200 && /^4000/.test(office?.number) && office.limitEur === 30, `Office card (€30) issued at once: •••• ${office?.last4}`)
  check(Math.abs(await spent() - 30) < 0.001, 'The card limit is held on the budget right away')

  // 2. The agent pays the shop with it: the charge is authorized in real time
  r = await shop('/api/office/orders', { items: [{ sku: 'badges', quantity: 10 }], shipTo: company, card: cardOf(office) })
  check(r.status === 200 && /^OF-/.test(r.json.order), `The shop accepts the card: order ${r.json.order}`)
  let ledger = (await adminCall('/v1/ledger')).json as any[]
  check(ledger.some(e => e.decision === 'allow' && e.rail === 'card' && /^auth_/.test(e.authId) && e.amountEur === 30), 'Audit log: card payment with its authorization id')

  // 3. Re-using the single-use card is declined in real time
  r = await shop('/api/office/orders', { items: [{ sku: 'pens', quantity: 1 }], shipTo: company, card: cardOf(office) })
  check(r.status === 403 && /single-use card already used/.test(r.json.error), 'Re-using the card: declined in real time')
  ledger = (await adminCall('/v1/ledger')).json
  check(ledger.some(e => e.decision === 'deny' && e.rail === 'card' && /declined in real time/.test(e.reason)), 'The declined attempt is in the audit log')

  // 4. A hotel card above the approval threshold: waits for a human, delivered later
  r = await agent('/v1/cards', 'POST', { merchantName: 'City Lodge München', merchantDomain: 'localhost', category: 'travel.hotel', amountEur: 178, tolerancePercent: 10, validDays: 10,
    items: [{ name: 'Compact room', quantity: 2, unitPriceEur: 89, unit: 'night' }], purpose: 'Hotel for the TBC26 fair', waitSeconds: 0 })
  const reqId = r.json.requestId
  check(r.status === 202 && /^R-/.test(reqId), `Hotel card (€178) needs approval: ${reqId}`)
  const stats = (await adminCall('/v1/stats')).json
  check(stats.pending.some((p: any) => p.id === reqId && p.kind === 'card' && p.card.limitEur === 195.8), 'The dashboard shows the card request (limit €195.80 with 10 % tolerance)')
  await adminCall(`/v1/admin/approvals/${reqId}`, 'POST', { approve: true })
  for (let i = 0; i < 20 && (await agent(`/v1/requests/${reqId}`)).json.status !== 'completed'; i++) await sleep(200)
  r = await agent(`/v1/requests/${reqId}/result`)
  const hotel = r.json
  check(r.status === 200 && /^4000/.test(hotel.number) && hotel.limitEur === 195.8, `After approval the agent fetches the card: •••• ${hotel.last4}`)
  check((await agent(`/v1/requests/${reqId}/result`)).status === 409, 'The card details can be fetched only once')

  // 5. Misuse of the hotel card is declined
  r = await shop('/api/software/subscribe', { plan: 'notes', seats: 1, card: cardOf(hotel) })
  check(r.status === 403 && /merchant category software \(MCC 5734\) does not match travel.hotel/.test(r.json.error), 'Hotel card used in a software shop: declined (wrong merchant category)')
  r = await shop('/api/hotels/book', { hotel: 'isar', room: 'deluxe', checkIn, nights: 1, guest: 'Alfred M.', card: cardOf(hotel) })
  check(r.status === 403 && /above the card limit/.test(r.json.error), 'Hotel card for a €220 room: declined (above the card limit)')
  r = await shop('/api/hotels/book', { hotel: 'citylodge', room: 'standard', checkIn, nights: 2, guest: 'Alfred M.', card: { ...cardOf(hotel), cvc: '000' } })
  check(r.status === 403 && /Wrong security code/.test(r.json.error), 'Wrong security code: declined')

  // 6. The approved booking goes through; the hold becomes the real amount
  const before = await spent()
  r = await shop('/api/hotels/book', { hotel: 'citylodge', room: 'standard', checkIn, nights: 2, guest: 'Alfred M.', card: cardOf(hotel) })
  check(r.status === 200 && /^TR-/.test(r.json.confirmation), `The approved booking is paid by card: ${r.json.confirmation}`)
  check(Math.abs(before - (await spent()) - (195.8 - 178)) < 0.001, 'Budget: the €195.80 hold becomes the €178 actually charged')
  ledger = (await adminCall('/v1/ledger')).json
  check(ledger.some(e => e.decision === 'allow' && e.rail === 'card' && e.requestId === reqId && e.approvedBy === 'Alfred (dashboard)'), 'Card payment linked to the approval in the audit log')

  // 7. The policy applies to cards too
  r = await agent('/v1/cards', 'POST', { merchantName: 'Some Shop', merchantDomain: 'localhost', category: 'software', amountEur: 380, tolerancePercent: 10, purpose: 'Too large' })
  check(r.status === 403 && /exceeds max per payment/.test(r.json.reason), 'A card whose limit exceeds the max per payment is refused')
  r = await agent('/v1/cards', 'POST', { merchantName: 'Restaurant', merchantDomain: 'localhost', category: 'food.restaurant', amountEur: 40, purpose: 'Team dinner' })
  check(r.status === 403 && /category not allowed/.test(r.json.reason), 'A card in a category the agent may not buy is refused')
  r = await agent('/v1/cards', 'POST', { merchantName: 'Elsewhere', merchantDomain: 'evil.example', amountEur: 10, purpose: 'Other merchant' })
  check(r.status === 403 && /domain not allowed/i.test(r.json.reason), 'A card for a merchant outside the allowed domains is refused')

  // 8. Cancelling an unused card releases the budget
  r = await agent('/v1/cards', 'POST', { merchantName: 'Bürobedarf Weber', merchantDomain: 'localhost', category: 'office.supplies', amountEur: 20, purpose: 'Pens' })
  const extra = r.json.card
  const held = await spent()
  await adminCall(`/v1/admin/cards/${extra.cardId}`, 'DELETE')
  check(Math.abs(held - (await spent()) - 20) < 0.001, 'Admin cancels an unused card: its €20 hold is released')
  r = await shop('/api/office/orders', { items: [{ sku: 'pens', quantity: 1 }], shipTo: company, card: cardOf(extra) })
  check(r.status === 403 && /card cancelled/.test(r.json.error), 'The cancelled card is declined')

  // 9. Accounting and security of the network
  const datev = await fetch(`${PROXY}/v1/export/datev`, { headers: { 'X-Admin-Token': ADMIN } }).then(x => x.text())
  check((datev.match(/"auth_/g) ?? []).length === 2, 'DATEV export includes both card payments (authorization id as voucher reference)')
  const bad = await fetch(`${PROXY}/v1/card-network/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Network-Key': 'wrong' }, body: '{}' })
  check(bad.status === 401, 'The card network only accepts known merchant acquirers')
  const list = (await agent('/v1/cards')).json as any[]
  check(list.length === 3 && list.every(c => !('numberHash' in c) && !('number' in c)), 'Card lists never contain card numbers')
} catch (e) {
  console.error(e); failures++
} finally {
  for (const p of procs) p.kill()
  rmSync(dir, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll card rail checks passed')
process.exit(failures ? 1 : 0)
