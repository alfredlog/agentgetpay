// Test hors ligne : simule un portefeuille approvisionné et un vendeur qui ne diffuse pas.
// Lance d'abord le vendeur avec SKIP_BROADCAST=1.
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { payFetch } from '../agent/pay-fetch.js'
import { UtxoProvider } from '../shared/utxo.js'

const key = PrivateKey.fromRandom()

// Une fausse transaction qui "donne" 5000 sats à l'agent
const funding = new Transaction()
funding.addOutput({ lockingScript: new P2PKH().lock(key.toAddress('testnet')), satoshis: 5000 })
const fakeUtxos: UtxoProvider = {
  async findUtxo() { return { sourceTransaction: funding, outputIndex: 0, satoshis: 5000 } }
}

const url = 'http://localhost:4000/api/quote'
const { response, paid } = await payFetch(url, { method: 'GET' }, { address: key.toAddress('testnet'), unlocker: () => new P2PKH().unlock(key), utxos: fakeUtxos, maxSats: 100 })
console.log('Status:', response.status, '| Paid:', paid)
console.log('Response:', await response.json())

// Le garde-fou doit bloquer un prix trop élevé
try {
  await payFetch(url, { method: 'GET' }, { address: key.toAddress('testnet'), unlocker: () => new P2PKH().unlock(key), utxos: fakeUtxos, maxSats: 5 })
  console.log('ERROR: the guard should have blocked')
} catch (e) {
  console.log('Guard OK:', (e as Error).message)
}
