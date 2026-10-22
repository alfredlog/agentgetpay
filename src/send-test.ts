// Envoie des satoshis : npm run send -- <adresse> <montant>
// Sans argument : 100 satoshis à soi-même (le premier vrai paiement sur le testnet).
import 'dotenv/config'
import { PrivateKey, Transaction, P2PKH, WhatsOnChainBroadcaster } from '@bsv/sdk'
import { getUtxos, getTxHex } from './woc.js'

const AMOUNT = Number(process.argv[3] ?? 100) // satoshis
if (!Number.isInteger(AMOUNT) || AMOUNT < 1) throw new Error('Amount must be a whole number of satoshis')
const key = PrivateKey.fromWif(process.env.BSV_WIF!)
const address = key.toAddress('testnet')
const recipient = process.argv[2] ?? address // par défaut : soi-même

// 1. Trouver une pièce (UTXO) assez grosse pour payer montant + frais
const utxo = (await getUtxos(address)).find(u => u.value > AMOUNT + 50)
if (!utxo) throw new Error('Not enough funds: request coins from the faucet.')

// 2. Construire la transaction
const tx = new Transaction()
tx.addInput({
  sourceTransaction: Transaction.fromHex(await getTxHex(utxo.tx_hash)),
  sourceOutputIndex: utxo.tx_pos,
  unlockingScriptTemplate: new P2PKH().unlock(key)
})
tx.addOutput({ lockingScript: new P2PKH().lock(recipient), satoshis: AMOUNT })
tx.addOutput({ lockingScript: new P2PKH().lock(address), change: true }) // la monnaie revient

// 3. Calculer les frais, signer, diffuser
await tx.fee()
await tx.sign()
const result = await tx.broadcast(new WhatsOnChainBroadcaster('test'))

if (result.status === 'success') {
  console.log('Payment sent!')
  console.log(`https://test.whatsonchain.com/tx/${tx.id('hex')}`)
} else {
  console.error('Failed:', result)
}
