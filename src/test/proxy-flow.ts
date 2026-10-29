// Offline test proxy: fake P2PKH wallet and fake chain for the audit-log anchors; the payer wallet
// (BRC-121 payments, BRC-29 refunds) is a real wallet-toolbox wallet on the shared mock chain (MOCK_CHAIN_DB).
import 'dotenv/config'
import { PrivateKey, Transaction, P2PKH, Broadcaster } from '../shared/bsv.js'
import { addressNetwork } from '../shared/network.js'
import { spendableSats } from '../shared/wallet.js'
import { openMockChain } from './helpers/mockchain.js'

if (!process.env.MOCK_CHAIN_DB) throw new Error('MOCK_CHAIN_DB missing: the test runner prepares the mock chain')
const key = PrivateKey.fromWif(process.env.BSV_WIF!)
const funding = new Transaction()
funding.addOutput({ lockingScript: new P2PKH().lock(key.toAddress(addressNetwork())), satoshis: 100000 })

// Fake blockchain for anchors: keeps the "broadcast" transactions in memory
const chain = new Map<string, string>()
const broadcaster = {
  async broadcast(tx: Transaction) {
    chain.set(tx.id('hex'), tx.toHex())
    return { status: 'success', txid: tx.id('hex'), message: 'fake broadcast' }
  }
} as unknown as Broadcaster

const { createProxy, openPayerWallet } = await import('../proxy/server.js')
const payer = await openPayerWallet()
// Fund it once (the wallet file survives a proxy restart in the tests)
if (await spendableSats(payer) < 1_000_000) await (await openMockChain(process.env.MOCK_CHAIN_DB)).fund(payer, 5_000_000)

createProxy(
  { async findUtxo() { return { sourceTransaction: funding, outputIndex: 0, satoshis: 100000 } } },
  { broadcaster, fetchTxHex: async txid => chain.get(txid) ?? Promise.reject(new Error('unknown tx')), payer: Promise.resolve(payer) }
).listen(Number(process.env.PROXY_PORT ?? 5050), '127.0.0.1', () => console.log('Test proxy ready (mock chain payer wallet, fake anchor chain)'))
