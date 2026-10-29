// Shows the address and balance of the testnet wallet.
import 'dotenv/config'
import { PrivateKey } from './shared/bsv.js'
import { getUtxos } from './woc.js'
import { addressNetwork, explorerAddress } from './shared/network.js'

const key = PrivateKey.fromWif(process.env.BSV_WIF!)
const address = key.toAddress(addressNetwork())
console.log('Address:', address) // printed first: useful even if WhatsOnChain does not answer
const utxos = await getUtxos(address)
const total = utxos.reduce((s, u) => s + u.value, 0)

console.log(`Balance: ${total} satoshis (${utxos.length} UTXO)`)
console.log(`Explorer: ${explorerAddress(address)}`)
