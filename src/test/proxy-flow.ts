// Test hors ligne du proxy : faux portefeuille, fausse blockchain, vendeur en SKIP_BROADCAST=1.
import 'dotenv/config'
import { PrivateKey, Transaction, P2PKH, Broadcaster } from '@bsv/sdk'

const key = PrivateKey.fromWif(process.env.BSV_WIF!)
const funding = new Transaction()
funding.addOutput({ lockingScript: new P2PKH().lock(key.toAddress('testnet')), satoshis: 100000 })

// Fausse blockchain : garde les transactions "diffusées" en mémoire
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
).listen(5050, () => console.log('Test proxy ready (fake wallet, fake chain)'))
