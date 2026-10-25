// Sends satoshis: npm run send -- <address> <amount>
// Without arguments: 100 satoshis to yourself (the first real payment on testnet).
import 'dotenv/config'
import { PrivateKey, Transaction, P2PKH, WhatsOnChainBroadcaster } from '@bsv/sdk'
import { getUtxos, getTxHex } from './woc.js'

const AMOUNT = Number(process.argv[3] ?? 100) // satoshis
if (!Number.isInteger(AMOUNT) || AMOUNT < 1) throw new Error('Amount must be a whole number of satoshis')
const key = PrivateKey.fromWif(process.env.BSV_WIF!)
const address = key.toAddress('testnet')
const recipient = process.argv[2] ?? address // default: yourself

// 1. Find a coin (UTXO) large enough to pay amount + fees
const utxo = (await getUtxos(address)).find(u => u.value > AMOUNT + 50)
if (!utxo) throw new Error('Not enough funds: request coins from the faucet.')

// 2. Build the transaction
const tx = new Transaction()
tx.addInput({
  sourceTransaction: Transaction.fromHex(await getTxHex(utxo.tx_hash)),
  sourceOutputIndex: utxo.tx_pos,
  unlockingScriptTemplate: new P2PKH().unlock(key)
})
tx.addOutput({ lockingScript: new P2PKH().lock(recipient), satoshis: AMOUNT })
tx.addOutput({ lockingScript: new P2PKH().lock(address), change: true }) // the change comes back

// 3. Compute fees, sign, broadcast
await tx.fee()
await tx.sign()
const result = await tx.broadcast(new WhatsOnChainBroadcaster('test'))

if (result.status === 'success') {
  console.log('Payment sent!')
  console.log(`https://test.whatsonchain.com/tx/${tx.id('hex')}`)
} else {
  console.error('Failed:', result)
}
