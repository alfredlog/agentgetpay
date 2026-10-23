// Offline test: simulates a funded wallet and a seller that does not broadcast.
// Start the seller first with SKIP_BROADCAST=1.
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { payFetch } from '../agent/pay-fetch.js'
import { UtxoProvider } from '../shared/utxo.js'

const key = PrivateKey.fromRandom()

// A fake transaction that "gives" 5000 sats to the agent
const funding = new Transaction()
funding.addOutput({ lockingScript: new P2PKH().lock(key.toAddress('testnet')), satoshis: 5000 })
const fakeUtxos: UtxoProvider = {
  async findUtxo() { return { sourceTransaction: funding, outputIndex: 0, satoshis: 5000 } }
}

const url = 'http://localhost:4000/api/quote'
const { response, paid } = await payFetch(url, { method: 'GET' }, { address: key.toAddress('testnet'), unlocker: () => new P2PKH().unlock(key), utxos: fakeUtxos, maxSats: 100 })
console.log('Status:', response.status, '| Paid:', paid)
console.log('Response:', await response.json())

// The safeguard must block a price that is too high
try {
  await payFetch(url, { method: 'GET' }, { address: key.toAddress('testnet'), unlocker: () => new P2PKH().unlock(key), utxos: fakeUtxos, maxSats: 5 })
  console.log('ERROR: the guard should have blocked')
} catch (e) {
  console.log('Guard OK:', (e as Error).message)
}
