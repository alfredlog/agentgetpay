// Offline test of the proxy: fake wallet, fake blockchain, seller with SKIP_BROADCAST=1.
import 'dotenv/config'
import { PrivateKey, Transaction, P2PKH, Broadcaster } from '../shared/bsv.js'
import { addressNetwork } from '../shared/network.js'

const key = PrivateKey.fromWif(process.env.BSV_WIF!)
const funding = new Transaction()
funding.addOutput({ lockingScript: new P2PKH().lock(key.toAddress(addressNetwork())), satoshis: 100000 })

// Fake blockchain: keeps the "broadcast" transactions in memory
const chain = new Map<string, string>()
const broadcaster = {
  async broadcast(tx: Transaction) {
    chain.set(tx.id('hex'), tx.toHex())
    return { status: 'success', txid: tx.id('hex'), message: 'fake broadcast' }
  }
} as unknown as Broadcaster

const { createProxy } = await import('../proxy/server.js')
createProxy(
  { async findUtxo() { return { sourceTransaction: funding, outputIndex: 0, satoshis: 100000 } } },
  { broadcaster, fetchTxHex: async txid => chain.get(txid) ?? Promise.reject(new Error('unknown tx')) }
).listen(Number(process.env.PROXY_PORT ?? 5050), '127.0.0.1', () => console.log('Test proxy ready (fake wallet, fake chain)'))
