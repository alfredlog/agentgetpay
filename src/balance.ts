// Shows the address and balance of the testnet wallet.
import 'dotenv/config'
import { PrivateKey } from '@bsv/sdk'
import { getUtxos } from './woc.js'

const key = PrivateKey.fromWif(process.env.BSV_WIF!)
const address = key.toAddress('testnet')
console.log('Address:', address) // printed first: useful even if WhatsOnChain does not answer
const utxos = await getUtxos(address)
const total = utxos.reduce((s, u) => s + u.value, 0)

console.log(`Balance: ${total} satoshis (${utxos.length} UTXO)`)
console.log(`Explorer: https://test.whatsonchain.com/address/${address}`)
