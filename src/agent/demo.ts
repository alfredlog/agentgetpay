// An "agent" that calls the paid API and pays by itself.
import 'dotenv/config'
import { PrivateKey, P2PKH } from '@bsv/sdk'
import { payFetch } from './pay-fetch.js'
import { WhatsOnChainUtxoProvider } from '../shared/utxo.js'

const key = PrivateKey.fromWif(process.env.BSV_WIF!)
const url = process.argv[2] ?? 'http://localhost:4000/api/quote'

const { response, paid } = await payFetch(url, { method: 'GET' }, { address: key.toAddress('testnet'), unlocker: () => new P2PKH().unlock(key), utxos: new WhatsOnChainUtxoProvider(),
  maxSats: 1000
})

console.log('Response:', await response.json())
if (paid) {
  console.log(`Paid ${paid.amount} sats`)
  console.log(`https://test.whatsonchain.com/tx/${paid.txid}`)
}
