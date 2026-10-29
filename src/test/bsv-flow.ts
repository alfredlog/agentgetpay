// Test of the BSV plumbing: one build of @bsv/sdk in the process, the Arcade broadcaster and
// chain tracker (against a local fake Arcade), and the BSV_NETWORK setting. Offline.
import { createServer, type IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { PrivateKey, Transaction, P2PKH, sdkModule } from '../shared/bsv.js'
import { ArcadeBroadcaster, ArcadeChainTracker, arcadeUrl, ARCADE_MAINNET, ARCADE_TESTNET } from '../shared/arcade.js'
import { bsvNetwork, addressNetwork, explorerTx } from '../shared/network.js'

let failures = 0
const check = (ok: boolean, label: string) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) failures++ }

// ---- 1. One build of @bsv/sdk ----
const require = createRequire(import.meta.url)
const toolboxEntry = require.resolve('@bsv/wallet-toolbox')
require('@bsv/wallet-toolbox') // loads the CJS build of the SDK, as in a real server wallet
const sdkSeenByToolbox = createRequire(toolboxEntry)('@bsv/sdk')
check(sdkSeenByToolbox === sdkModule, 'wallet-toolbox and our code share the same @bsv/sdk module')
check(sdkSeenByToolbox.Transaction === Transaction, 'Transaction is one class in the whole process')

// Every file goes through src/shared/bsv.ts: no direct import of @bsv/sdk elsewhere
const walk = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [] })
const direct = walk('src').filter(f => !f.endsWith(join('shared', 'bsv.ts')))
  .filter(f => /from\s+['"]@bsv\/sdk|import\(\s*['"]@bsv\/sdk|require\(\s*['"]@bsv\/sdk/.test(readFileSync(f, 'utf8')))
check(direct.length === 0, `no file imports @bsv/sdk directly${direct.length ? ': ' + direct.map(f => relative('.', f)).join(', ') : ''}`)
// @bsv/402-pay also has an ESM build (with the ESM SDK): only src/shared/brc121.ts loads it
const pay402 = walk('src').filter(f => !f.endsWith(join('shared', 'brc121.ts')))
  .filter(f => /from\s+['"]@bsv\/402-pay|import\(\s*['"]@bsv\/402-pay|require\(\s*['"]@bsv\/402-pay/.test(readFileSync(f, 'utf8')))
check(pay402.length === 0, `no file imports @bsv/402-pay directly${pay402.length ? ': ' + pay402.map(f => relative('.', f)).join(', ') : ''}`)
const { createPaymentMiddleware } = await import('../shared/brc121.js')
check(typeof createPaymentMiddleware === 'function' && require.cache[require.resolve('@bsv/402-pay/server')] !== undefined, '@bsv/402-pay is loaded as CommonJS (same SDK build)')

// ---- 2. Fake Arcade ----
const posted: { rawTx: string }[] = []
let headerRequests = 0
let nextReply: { status: number; body: unknown } = { status: 202, body: {} }
const ROOT_100 = 'AB'.repeat(32)
const readBody = (req: IncomingMessage) => new Promise<string>(r => { let s = ''; req.on('data', c => (s += c)); req.on('end', () => r(s)) })
const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.method === 'POST' && req.url === '/tx') { posted.push(JSON.parse(await readBody(req))); return send(nextReply.status, nextReply.body) }
  if (req.url === '/chaintracks/v2/height') return send(200, { height: 971454 })
  const m = req.url?.match(/^\/chaintracks\/v2\/header\/height\/(\d+)$/)
  if (m) { headerRequests++; return Number(m[1]) === 100 ? send(200, { merkleRoot: ROOT_100, height: 100 }) : send(404, { error: 'not found' }) }
  send(404, {})
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`

// A signed transaction whose input has its source transaction: EF is possible
const key = PrivateKey.fromRandom()
const funding = new Transaction()
funding.addOutput({ lockingScript: new P2PKH().lock(key.toAddress(addressNetwork())), satoshis: 5000 })
const tx = new Transaction()
tx.addInput({ sourceTransaction: funding, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) })
tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress(addressNetwork())), satoshis: 1000 })
tx.addOutput({ lockingScript: new P2PKH().lock(key.toAddress(addressNetwork())), change: true })
await tx.fee()
await tx.sign()
const txid = tx.id('hex')

// ---- 3. Broadcaster ----
const arcade = new ArcadeBroadcaster(url)
nextReply = { status: 202, body: { txid, txStatus: 'SEEN_ON_NETWORK' } }
let r = await tx.broadcast(arcade)
check(r.status === 'success' && r.txid === txid, 'accepted broadcast → success with the txid')
check(posted.at(-1)?.rawTx === tx.toHexEF(), 'POST /tx body is { rawTx } in Extended Format')
check(posted.at(-1)?.rawTx.slice(8, 20).toLowerCase() === '0000000000ef', 'the posted transaction carries the EF marker')

nextReply = { status: 200, body: { txid, txStatus: 'DOUBLE_SPEND_ATTEMPTED', competingTxs: ['00'.repeat(32)] } }
r = await tx.broadcast(arcade)
check(r.status === 'error' && r.code === 'DOUBLE_SPEND', 'double spend → error')

nextReply = { status: 200, body: { txid, txStatus: 'REJECTED', extraInfo: 'bad script' } }
r = await tx.broadcast(arcade)
check(r.status === 'error' && r.code === 'REJECTED', 'REJECTED status → error')

nextReply = { status: 400, body: { detail: 'failed to parse transaction' } }
r = await tx.broadcast(arcade)
check(r.status === 'error' && r.code === '400' && r.description === 'failed to parse transaction', 'HTTP 400 → error with Arcade\'s detail')

// A payment received as plain raw hex has no source transactions: sent as raw hex
const received = Transaction.fromHex(tx.toHex())
nextReply = { status: 202, body: { txid, txStatus: 'SEEN_ON_NETWORK' } }
r = await received.broadcast(arcade)
check(r.status === 'success' && posted.at(-1)?.rawTx === tx.toHex(), 'transaction without source data → raw hex')

r = await tx.broadcast(new ArcadeBroadcaster('http://127.0.0.1:1'))
check(r.status === 'error' && r.code === 'NETWORK', 'unreachable Arcade → error, no exception')

// ---- 4. Chain tracker ----
const tracker = new ArcadeChainTracker(url)
check(await tracker.isValidRootForHeight(ROOT_100.toLowerCase(), 100), 'valid merkle root (case-insensitive)')
check(!(await tracker.isValidRootForHeight('cd'.repeat(32), 100)), 'wrong merkle root → false')
check(headerRequests === 1, 'block header fetched once, then cached')
check(!(await tracker.isValidRootForHeight(ROOT_100, 999)), 'unknown height (404) → false')
check(await tracker.currentHeight() === 971454, 'current height')

server.close()

// ---- 5. BSV_NETWORK ----
const saved = { n: process.env.BSV_NETWORK, a: process.env.ARCADE_URL }
delete process.env.ARCADE_URL
delete process.env.BSV_NETWORK
check(bsvNetwork() === 'test' && arcadeUrl() === ARCADE_TESTNET, 'default: testnet, testnet Arcade')
check(explorerTx('ab') === 'https://test.whatsonchain.com/tx/ab', 'testnet explorer link')
process.env.BSV_NETWORK = 'main'
check(arcadeUrl() === ARCADE_MAINNET && addressNetwork() === 'mainnet', 'BSV_NETWORK=main: mainnet Arcade, mainnet addresses')
check(key.toAddress(addressNetwork()).startsWith('1'), 'mainnet address starts with 1')
check(explorerTx('ab') === 'https://whatsonchain.com/tx/ab', 'mainnet explorer link')
process.env.ARCADE_URL = 'https://arcade.example/'
check(arcadeUrl() === 'https://arcade.example', 'ARCADE_URL overrides the default')
process.env.BSV_NETWORK = 'regtest'
let threw = false
try { bsvNetwork() } catch { threw = true }
check(threw, 'invalid BSV_NETWORK is refused')
for (const [k, v] of [['BSV_NETWORK', saved.n], ['ARCADE_URL', saved.a]] as const) {
  if (v === undefined) delete process.env[k]; else process.env[k] = v
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll BSV checks passed')
process.exit(failures ? 1 : 0)
