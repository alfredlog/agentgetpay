// An "agent" that calls the paid API and pays by itself (BRC-121), without the proxy.
// It uses the payer wallet (PAYER_ROOT_KEY, created by the proxy): do not run it while the proxy runs.
import 'dotenv/config'
import { payFetch } from './pay-fetch.js'
import { openServerWallet } from '../shared/wallet.js'
import { explorerTx } from '../shared/network.js'

if (!process.env.PAYER_ROOT_KEY) throw new Error('PAYER_ROOT_KEY missing in .env (start the proxy once: npm run proxy)')
const wallet = await openServerWallet({ rootKeyHex: process.env.PAYER_ROOT_KEY, filePath: process.env.PAYER_WALLET_FILE ?? 'data/payer-wallet.sqlite', databaseName: 'payer_wallet' })
const url = process.argv[2] ?? 'http://localhost:4000/api/quote'

const { response, paid } = await payFetch(url, { method: 'GET' }, { wallet, maxSats: 1000 })

console.log('Response:', await response.json())
if (paid) {
  console.log(`Paid ${paid.amount} sats`)
  console.log(explorerTx(paid.txid))
}
process.exit(0) // the wallet monitor would keep the process alive
