// Offline test of agent allowances on wallet-toolbox's mock chain. A wallet-toolbox wallet stands in
// for BSV Desktop (same WalletInterface). Proves: funding; a purchase triggers a top-up and a BRC-121
// payment; the agent key alone and the policy key alone cannot spend the allowance; the company can
// reclaim; an empty allowance is refused.
import express from 'express'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { P2PKH, PrivateKey, Transaction, Utils } from '../shared/bsv.js'
import { Mutex } from '../shared/mutex.js'
import { spendableSats } from '../shared/wallet.js'
import { openMockChain } from './helpers/mockchain.js'
import { createAllowances, AllowanceEmpty } from '../allowance/allowances.js'
import { LocalAgentSigners } from '../allowance/agent-signer.js'
import { fundAllowance, reclaimAllowance, type AdminApi } from '../allowance/company.js'
import { AllowanceScript, policyKeyId, walletSigner } from '../allowance/script.js'
import { createSeller } from '../shared/seller-kit.js'
import { payFetch } from '../agent/pay-fetch.js'
import { QUOTE_PATH } from '../shared/order.js'

let failures = 0
const check = (ok: boolean, label: string) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) failures++ }
const dir = mkdtempSync(join(tmpdir(), 'agentgetpay-allowance-'))
process.env.MOCK_CHAIN_DB = join(dir, 'chain.sqlite') // the agent wallets open the same chain
const chain = await openMockChain(process.env.MOCK_CHAIN_DB)
while ((await chain.services.getHeight()) < 110) await chain.mineBlock()

const company = await chain.makeWallet()      // stands in for BSV Desktop
await chain.fund(company, 500_000)
const policy = await chain.makeWallet()
const merchant = await chain.makeWallet()
const agents = new LocalAgentSigners(join(dir, 'agents'))
const ledger: any[] = []
const allowances = createAllowances({
  file: join(dir, 'allowances.json'), policyWallet: async () => policy, agents,
  chainTracker: async () => chain.chainTracker, broadcaster: async () => chain.broadcaster,
  lock: new Mutex(), eurPerSat: 0.01, record: async e => { ledger.push(e) }
})
// The admin API, as the admin page calls it (here without HTTP)
const api: AdminApi = async (path, _method = 'GET', body?: any) => {
  const [, , id, op] = path.split('/')
  if (op === 'keys') return allowances.keys(id)
  if (op === 'fund') return allowances.fund(id, body, 'Test admin')
  if (op === 'reclaim') return allowances.reclaimed(id, body.beef, 'Test admin')
  return allowances.view(id)
}

const seller = createSeller({ wallet: merchant, log: () => {} })
const app = express()
app.use(express.json())
app.post(QUOTE_PATH, seller.quote)
app.get('/api/report', seller.requirePayment('GET /api/report', 3000, 'Report'), (_req, res) => res.json({ report: 'ok' }))
const server: Server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/report`

try {
  // 1. Funding by the company
  const companyBefore = await spendableSats(company)
  const v = await fundAllowance(company, api, 'agent-a', 20_000)
  check(v.status === 'open' && v.balanceSats === 20_000, 'The company funds a 20000-sat allowance')
  check(await spendableSats(company) < companyBefore - 20_000 + 1 && ledger.some(e => e.action === 'allowance_fund' && e.txid === v.utxos[0].txid), 'The money left the company wallet; funding recorded with its txid')
  const k = await allowances.keys('agent-a')
  const identityA = await agents.get('agent-a').identityKey()
  check(![k.agentPub, k.policyPub].includes(identityA) && v.lockingScript?.includes(k.agentPub) && v.lockingScript.includes(k.policyPub), 'The script uses derived keys, not identity keys')
  const wrong = await allowances.fund('agent-a', { beef: [1, 2, 3], outputIndex: 0, companyPub: k.agentPub }).then(() => false, () => true)
  check(wrong, 'A malformed funding is refused')

  // 2. A purchase: top-up just in time, then a BRC-121 payment from the agent wallet
  const agentWallet = await allowances.agentWallet('agent-a')
  check(await spendableSats(agentWallet) === 0, 'The agent wallet starts empty')
  const merchantBefore = await spendableSats(merchant)
  const r = await payFetch(url, {}, { wallet: agentWallet, beforePay: async () => true, beforeSpend: async o => { await allowances.ensureFunds('agent-a', o.amount, url) } })
  check(r.response.status === 200 && r.paid?.amount === 3000, 'The purchase is paid with BRC-121')
  check(await spendableSats(merchant) === merchantBefore + 3000, 'The merchant is credited')
  const topup = ledger.find(e => e.action === 'allowance_topup')
  check(!!topup?.txid && topup.amountSats === 3200, `Top-up recorded with its txid (${topup?.amountSats} sats: price + fee buffer)`)
  const after = allowances.view('agent-a')
  check(after.balanceSats > 0 && after.balanceSats < 20_000 - 3200 && after.utxos[0].txid === topup.txid, `Change back to the same allowance script (${after.balanceSats} sats left)`)

  // 3. One key alone cannot spend the allowance (script check of a spend, nothing is broadcast)
  const spendWith = async (sigA: (h: number[]) => Promise<number[]>, sigP: (h: number[]) => Promise<number[]>) => {
    const view = allowances.view('agent-a')
    const u = view.utxos[0]
    const source = Transaction.fromBEEF(Utils.toArray(view.beef!, 'hex'), u.txid)
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: u.vout, unlockingScriptTemplate: new AllowanceScript().unlock(sigA, sigP) })
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: u.satoshis - 200 })
    await tx.sign()
    return await tx.verify('scripts only').catch(() => false) // checked locally: nothing is broadcast
  }
  const agentSigner = agents.get('agent-a').signAllowance
  const policySigner = walletSigner(policy, policyKeyId('agent-a'))
  check(await spendWith(agentSigner, policySigner), 'Control: agent + policy signatures are valid')
  check(!(await spendWith(agentSigner, agentSigner)), 'The agent key alone cannot spend the allowance')
  check(!(await spendWith(policySigner, policySigner)), 'The policy key alone cannot spend the allowance')

  // 4. An allowance too small for the purchase is refused
  const big = await allowances.ensureFunds('agent-a', 1_000_000, url).then(() => undefined, e => e as Error)
  check(big instanceof AllowanceEmpty && /allowance empty: ask the company to top up/.test(big.message), 'Allowance too small: refused with a clear reason')
  const none = await allowances.ensureFunds('agent-b', 1000, url).then(() => undefined, e => e as Error)
  check(none instanceof AllowanceEmpty, 'No allowance at all: refused')

  // 5. The company reclaims what is left
  const left = allowances.view('agent-a').balanceSats
  const companyMid = await spendableSats(company)
  const closed = await reclaimAllowance(company, api, 'agent-a')
  check(closed.status === 'closed' && allowances.balance('agent-a') === 0, 'The company reclaims the allowance: closed')
  const gain = await spendableSats(company) - companyMid
  check(gain > left - 200 && gain <= left, `The money is back in the company wallet (+${gain} of ${left} sats)`)
  check(ledger.some(e => e.action === 'allowance_reclaim' && e.amountSats === left && !!e.txid), 'Reclaim recorded with its txid')
  const again = await allowances.ensureFunds('agent-a', 3000, url).then(() => undefined, e => e as Error)
  check(again instanceof AllowanceEmpty, 'After the reclaim, purchases are refused')
} catch (e) {
  console.error(e); failures++
} finally {
  server.close()
  await chain.close()
  rmSync(dir, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} failure(s)` : '\nAll allowance checks passed')
process.exit(failures ? 1 : 0)
