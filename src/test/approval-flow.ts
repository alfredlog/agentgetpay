// End-to-end test of long approvals, refunds and mandates.
// Fake wallet, fake blockchain, demo market: nothing is paid, nothing on your machine is touched.
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import http from 'node:http'
import { PrivateKey } from '../shared/bsv.js'
import { prepareMockChain } from './helpers/mockchain.js'

const PROXY_PORT = 5550, MARKET_PORT = 5580, HOOK_PORT = 5590
const PROXY = `http://127.0.0.1:${PROXY_PORT}`, MARKET = `http://localhost:${MARKET_PORT}`
const ADMIN = 'test-admin-password-123'
const root = resolve('.')
const dir = mkdtempSync(join(tmpdir(), 'agentgetpay-approval-'))
cpSync(join(root, 'config'), join(dir, 'config'), { recursive: true })
writeFileSync(join(dir, '.env'), `BSV_WIF=${PrivateKey.fromRandom().toWif()}\nADMIN_TOKEN=${ADMIN}\nMARKET_SECRET=test-market-secret-123456\n`)
// Shared offline chain (wallet-toolbox mock chain) for every process started below
process.env.MOCK_CHAIN_DB = join(dir, 'chain.sqlite')
await prepareMockChain(process.env.MOCK_CHAIN_DB)

// The agent's callback address: we record what it receives
const hooks: any[] = []
const hookServer = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { hooks.push(JSON.parse(b)); res.end('ok') }) }).listen(HOOK_PORT)

const tsx = createRequire(import.meta.url).resolve('tsx/cli')
const procs: ChildProcess[] = []
const start = (file: string, env: Record<string, string>) => {
  const p = spawn(process.execPath, [tsx, join(root, file)], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
  p.stderr!.on('data', d => { if (/error/i.test(String(d)) && !/Refund from|ignored/.test(String(d))) process.stderr.write(d) })
  procs.push(p)
  return p
}
// No Telegram, no automatic answer: only the dashboard decides
const startProxy = (env: Record<string, string> = {}) => start('src/test/proxy-flow.ts', { PROXY_PORT: String(PROXY_PORT), TELEGRAM_BOT_TOKEN: '', APPROVAL_AUTO: '', ...env })
start('src/market/server.ts', { MARKET_PORT: String(MARKET_PORT) })
let proxy = startProxy()

let failures = 0
const check = (ok: boolean, label: string) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) failures++ }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const waitUp = async () => { for (let i = 0; i < 80; i++) { if (await fetch(`${PROXY}/v1/stats`).then(() => fetch(`${MARKET}/api`)).then(() => true, () => false)) return; await sleep(250) } }
const adminCall = (path: string, method = 'GET', body?: unknown) => fetch(`${PROXY}${path}`, {
  method, headers: { 'X-Admin-Token': ADMIN, 'X-Admin-Name': 'Alfred', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) as any }))
let key = ''
const agent = (path: string, method = 'GET', body?: unknown) => fetch(`${PROXY}${path}`, {
  method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
}).then(async r => ({ status: r.status, headers: r.headers, json: await r.json().catch(() => ({})) as any }))
const buy = (path: string, body: unknown, extra: Record<string, unknown> = {}) =>
  agent('/v1/fetch', 'POST', { url: `${MARKET}${path}`, method: 'POST', body, purpose: 'Approval test', ...extra })
const until = async (fn: () => Promise<boolean>, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (await fn()) return true; await sleep(200) } return false }
const company = { street: 'Leopoldstraße 1', postalCode: '80802', city: 'München', country: 'DE' }
const checkIn = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)
const hotel = { hotel: 'citylodge', room: 'standard', checkIn, nights: 2, guest: 'Alfred M.' }

try {
  await waitUp()
  key = (await adminCall('/v1/admin/agents', 'POST', { id: 'einkauf-01', rules: {
    daily_budget_eur: 600, monthly_budget_eur: 2000, max_per_payment_eur: 400, approval_above_eur: 100, allowed_domains: 'localhost',
    categories: { 'travel.hotel': { max_unit_price_eur: 150 }, 'office.supplies': { max_unit_price_eur: 50 }, software: { approval_above_eur: 0 } },
    shipping_addresses: [company]
  } })).json.apiKey

  // 1. An approval that takes time: the agent does not wait
  const t0 = Date.now()
  let r = await buy('/api/hotels/book', hotel, { waitSeconds: 1, callbackUrl: `http://localhost:${HOOK_PORT}/done` })
  const id = r.json.requestId
  check(r.status === 202 && /^R-[A-Z0-9]{6}$/.test(id) && Date.now() - t0 < 5000, `Hotel (€178) needs approval: the agent gets ${id} at once and continues`)
  check((await agent(`/v1/requests/${id}`)).json.status === 'pending', 'The agent can check its request: pending')

  // 2. Meanwhile, the agent carries on with its work
  r = await buy('/api/office/orders', { items: [{ sku: 'pens', quantity: 2 }], shipTo: company })
  check(r.status === 200 && /^OF-/.test(r.json.order), 'Meanwhile the agent keeps working: a small order is paid')

  // 3. The request survives a proxy restart
  proxy.kill(); await sleep(500); proxy = startProxy(); await waitUp()
  let stats = (await adminCall('/v1/stats')).json
  check(stats.pending.some((p: any) => p.id === id && p.order?.merchant === 'City Lodge München'), 'After a restart the request is still waiting on the dashboard')

  // 4. A human approves later: the purchase happens by itself
  const ok = await adminCall(`/v1/admin/approvals/${id}`, 'POST', { approve: true })
  check(ok.status === 200 && /executing/.test(ok.json.message), 'Admin approves on the dashboard: the purchase runs in the background')
  check(await until(async () => (await agent(`/v1/requests/${id}`)).json.status === 'completed'), 'The request becomes completed')
  const res = await agent(`/v1/requests/${id}/result`)
  const booking = res.json.confirmation
  check(res.status === 200 && /^TR-/.test(booking) && res.headers.get('X-Paid-Sats') === '17800', `The agent picks up the result later: booking ${booking}, 17800 sats paid`)
  let ledger = (await adminCall('/v1/ledger')).json as any[]
  check(ledger.some(e => e.decision === 'allow' && e.requestId === id && e.approvedBy === 'Alfred (dashboard)'), 'Audit log: paid, approved by Alfred (dashboard), linked to the request')
  check(await until(async () => hooks.some(h => h.requestId === id && h.status === 'completed' && h.paidSats === 17800)), 'The agent\'s callback address was notified')

  // 5. Approval while the agent is still waiting: direct answer
  const live = buy('/api/hotels/book', { ...hotel, hotel: 'alpenblick', nights: 1 }, { waitSeconds: 10 })
  await until(async () => (await adminCall('/v1/stats')).json.pending.length === 1, 4000)
  const liveId = (await adminCall('/v1/stats')).json.pending[0]?.id
  await adminCall(`/v1/admin/approvals/${liveId}`, 'POST', { approve: true })
  r = await live
  check(r.status === 200 && /^TR-/.test(r.json.confirmation), 'Approved while the agent was still waiting: it gets the booking directly')
  check((await agent(`/v1/requests/${liveId}`)).json.status === 'completed', 'That request is closed as completed')

  // 6. Refus
  r = await buy('/api/hotels/book', { ...hotel, nights: 3 }, { waitSeconds: 0 })
  const rejId = r.json.requestId
  await adminCall(`/v1/admin/approvals/${rejId}`, 'POST', { approve: false })
  const rej = (await agent(`/v1/requests/${rejId}`)).json
  ledger = (await adminCall('/v1/ledger')).json
  check(rej.status === 'rejected' && rej.decidedBy === 'Alfred (dashboard)' && ledger.some((e: any) => e.decision === 'deny' && e.requestId === rejId), 'A rejected request is closed and recorded as blocked')
  check((await adminCall(`/v1/admin/approvals/${rejId}`, 'POST', { approve: true })).status === 404, 'A decided request cannot be decided again')

  // 7. Cancellation: BRC-29 refund in BSV, verified, internalized and recorded
  const before = (await agent('/v1/me')).json.spentMonthEur
  r = await agent('/v1/fetch', 'POST', { url: `${MARKET}/api/cancel`, method: 'POST', body: { order: booking }, purpose: 'Trip cancelled' })
  const refunded = Number(r.headers.get('X-Refunded-Sats'))
  check(r.status === 200 && refunded === 17800, `Cancelling the booking refunds ${refunded} sats (BRC-29 refund of the full 17800; the merchant pays the fee)`)
  const after = (await agent('/v1/me')).json.spentMonthEur
  check(Math.abs(before - after - refunded * 0.01) < 0.001, `The monthly budget gets the money back (€${before} → €${after})`)
  ledger = (await adminCall('/v1/ledger')).json
  check(ledger.some((e: any) => e.decision === 'refund' && e.amountSats === refunded && e.order?.merchant === 'City Lodge München'), 'Audit log has a refund entry')
  const datev = await fetch(`${PROXY}/v1/export/datev`, { headers: { 'X-Admin-Token': ADMIN } }).then(x => x.text())
  check(/;"H";"EUR"/.test(datev) && /Refund AI einkauf-01/.test(datev), 'DATEV export books the refund as a credit (H)')
  r = await agent('/v1/fetch', 'POST', { url: `${MARKET}/api/cancel`, method: 'POST', body: { order: booking }, purpose: 'Cancel again' })
  check(r.status === 409 && !r.headers.get('X-Refunded-Sats'), 'Cancelling twice is refused, no second refund')

  // 8. Mandate: one approval for purchases that repeat
  r = await agent('/v1/fetch', 'POST', { url: `${MARKET}/api/software/subscribe`, method: 'POST', body: { plan: 'notes', seats: 3 }, purpose: 'Team notes', waitSeconds: 0 })
  check(r.status === 202, 'Without a mandate, a subscription waits for approval')
  await adminCall(`/v1/admin/approvals/${r.json.requestId}`, 'POST', { approve: false })
  const md = await agent('/v1/mandates', 'POST', { domain: 'localhost', category: 'software.subscription', maxEurPerMonth: 50, months: 12, purpose: 'Monthly team notes subscription' })
  check(md.status === 202 && md.json.kind === 'mandate', `The agent asks for a standing approval: ${md.json.id}`)
  await adminCall(`/v1/admin/approvals/${md.json.id}`, 'POST', { approve: true })
  const mdDone = (await agent(`/v1/requests/${md.json.id}`)).json
  const mandateId = mdDone.result?.mandateId
  check(mdDone.status === 'completed' && /^M-/.test(mandateId), `Approved: mandate ${mandateId} is active`)
  r = await agent('/v1/fetch', 'POST', { url: `${MARKET}/api/software/subscribe`, method: 'POST', body: { plan: 'notes', seats: 3 }, purpose: 'Team notes, month 1', waitSeconds: 0 })
  ledger = (await adminCall('/v1/ledger')).json
  check(r.status === 200 && ledger.some((e: any) => e.mandateId === mandateId && e.decision === 'allow' && /mandate/.test(e.approvedBy)), 'With the mandate, the subscription (€27) is paid at once')
  r = await agent('/v1/fetch', 'POST', { url: `${MARKET}/api/software/subscribe`, method: 'POST', body: { plan: 'notes', seats: 3 }, purpose: 'Team notes, extra', waitSeconds: 0 })
  check(r.status === 202, 'Beyond the mandate\'s €50/month, it needs approval again')
  await adminCall(`/v1/admin/approvals/${r.json.requestId}`, 'POST', { approve: false })
  const ms = (await adminCall('/v1/admin/mandates')).json
  check(ms[0]?.id === mandateId && Math.abs(ms[0].usedThisMonthEur - 27) < 0.001, 'Admin sees the mandate and how much was used this month (€27)')
  await adminCall(`/v1/admin/mandates/${mandateId}`, 'DELETE')
  check((await agent('/v1/mandates')).json.length === 0, 'Admin revokes the mandate: the agent no longer has it')

  // 9. No answer: the request expires
  proxy.kill(); await sleep(500); proxy = startProxy({ APPROVAL_TTL_HOURS: '0.0005', APPROVAL_SWEEP_MS: '300' }); await waitUp()
  r = await buy('/api/hotels/book', { ...hotel, nights: 2 }, { waitSeconds: 0 })
  const expId = r.json.requestId
  const expOk = await until(async () => (await agent(`/v1/requests/${expId}`)).json.status === 'expired', 6000)
  check(expOk, 'With no answer before the deadline, the request expires')
  stats = (await adminCall('/v1/stats')).json
  check(!stats.pending.some((p: any) => p.id === expId), 'An expired request leaves the dashboard')
} catch (e) {
  console.error(e); failures++
} finally {
  for (const p of procs) p.kill()
  hookServer.close()
  rmSync(dir, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll approval, refund and mandate checks passed')
process.exit(failures ? 1 : 0)
