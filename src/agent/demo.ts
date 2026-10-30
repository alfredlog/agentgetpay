// An "agent" that calls the paid API and pays by itself (BRC-121), without the proxy.
// It uses the agent's own wallet (data/agents/<id>/, created by the proxy): do not run it while the proxy runs.
// The wallet only holds what an allowance top-up gave it (see src/allowance).
import 'dotenv/config'
import { payFetch } from './pay-fetch.js'
import { LocalAgentSigners } from '../allowance/agent-signer.js'
import { explorerTx } from '../shared/network.js'

const url = process.argv[2] ?? 'http://localhost:4000/api/quote'
const wallet = await new LocalAgentSigners().get(process.argv[3] ?? process.env.AGENT_ID ?? 'demo-agent').wallet()

const { response, paid } = await payFetch(url, { method: 'GET' }, { wallet, maxSats: 1000 })

console.log('Response:', await response.json())
if (paid) {
  console.log(`Paid ${paid.amount} sats`)
  console.log(explorerTx(paid.txid))
}
process.exit(0) // the wallet monitor would keep the process alive
