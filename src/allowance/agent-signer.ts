// The AGENT's side of the allowance: its own wallet-toolbox wallet, run by the agent (the MCP server),
// never by the proxy. It co-signs allowance top-ups (with the proxy's policy key), receives the top-ups,
// pays merchants with BRC-121 and receives refunds.
//
// Before co-signing, the agent rebuilds the top-up from the description the proxy sends and checks it:
// every input spends its own allowance script, output 0 pays its OWN BRC-29 key no more than the price
// plus a small buffer, and any other output is change back to the same script. It then signs the
// sighashes it computed itself. So a proxy alone, even a compromised one, cannot move the allowance.
//
// Storage: one folder per agent in the MCP's data directory (MCP_DATA_DIR, default mcp-data/), with the
// root key (created once, owner-only, never printed) and the wallet database. Never in the proxy's data/.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { LockingScript, OP, P2PKH, PublicKey, Utils, type WalletInterface } from '../shared/bsv.js'
import { BRC29_PROTOCOL } from '../shared/payments.js'
import { openServerWallet } from '../shared/wallet.js'
import { AGENT_KEY_ID, registrationHash, sighashFor, walletPubKey, walletSigner, type HashSigner, type TxDescription } from './script.js'

export interface AgentSigner {
  agentId: string
  wallet(): Promise<WalletInterface>   // BRC-121 payer; receives top-ups and refunds
  identityKey(): Promise<string>       // BRC-29 recipient of the top-ups and refunds
  allowancePubKey(): Promise<string>   // agentPub in the allowance script (a derived key)
  signAllowance: HashSigner            // co-signs an allowance spend
}

export const mcpDataDir = () => process.env.MCP_DATA_DIR ?? 'mcp-data'

export class LocalAgentWallets {
  private wallets = new Map<string, Promise<WalletInterface>>()
  constructor(private dir = join(mcpDataDir(), 'agents')) {}

  get(agentId: string): AgentSigner {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(agentId)) throw new Error('Invalid agent id')
    const wallet = () => {
      let w = this.wallets.get(agentId)
      if (!w) { w = this.open(agentId); this.wallets.set(agentId, w); w.catch(() => this.wallets.delete(agentId)) }
      return w
    }
    return {
      agentId,
      wallet,
      identityKey: async () => (await (await wallet()).getPublicKey({ identityKey: true })).publicKey,
      allowancePubKey: async () => walletPubKey(await wallet(), AGENT_KEY_ID),
      signAllowance: async hash => walletSigner(await wallet(), AGENT_KEY_ID)(hash)
    }
  }

  // The agent's root key: created once, in its own file (owner-only), never printed
  private async open(agentId: string): Promise<WalletInterface> {
    const dir = join(this.dir, agentId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const keyFile = join(dir, 'root.key')
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' })
    chmodSync(keyFile, 0o600)
    return openServerWallet({ rootKeyHex: readFileSync(keyFile, 'utf8').trim(), filePath: join(dir, 'wallet.sqlite'), databaseName: `agent_${agentId.replace(/-/g, '_')}` })
  }
}

// What the agent sends to the proxy once (POST /v1/agent/keys): its keys, and a signature of them by the
// allowance key, so the proxy only accepts an agentPub whose holder can sign with it
export async function agentRegistration(s: AgentSigner) {
  const identityKey = await s.identityKey()
  const allowancePubKey = await s.allowancePubKey()
  const proof = Utils.toHex(await s.signAllowance(registrationHash(s.agentId, identityKey, allowancePubKey)))
  return { identityKey, allowancePubKey, proof }
}

// The BRC-29 data of a top-up output (the proxy's policy wallet is the sender)
export interface TopupInfo { satoshis: number; derivationPrefix: string; derivationSuffix: string; senderIdentityKey: string }

// Max extra a top-up may carry above the price (the fee of the agent's own payment)
const maxBuffer = () => Number(process.env.AGENT_MAX_TOPUP_BUFFER_SATS ?? 1000)

// Checks a top-up the proxy asks the agent to co-sign and returns the agent's signatures (DER, hex).
// `sats` is the price of the purchase it pays for.
export async function cosignTopup(s: AgentSigner, req: { tx: TxDescription; topup: TopupInfo; sats: number }): Promise<string[]> {
  const { tx, topup, sats } = req
  if (!tx || !Array.isArray(tx.inputs) || !Array.isArray(tx.outputs) || !tx.inputs.length) throw new Error('malformed top-up transaction')
  if (!Number.isSafeInteger(sats) || sats <= 0) throw new Error('malformed price')
  const agentPub = await s.allowancePubKey()

  // Every input spends the same allowance script, and that script holds OUR key in the agent branch
  const script = tx.inputs[0].lockingScript
  if (tx.inputs.some(i => i.lockingScript !== script)) throw new Error('the top-up spends outputs of different scripts')
  const chunks = LockingScript.fromHex(script).chunks
  if (chunks.length !== 9 || chunks[0].op !== OP.OP_IF || Utils.toHex(chunks[1].data ?? []) !== agentPub || chunks[2].op !== OP.OP_CHECKSIGVERIFY) {
    throw new Error('the top-up does not spend this agent\'s allowance')
  }

  // Output 0: our own BRC-29 key, at most the price plus the fee buffer
  const { publicKey } = await (await s.wallet()).getPublicKey({
    protocolID: BRC29_PROTOCOL, keyID: `${topup.derivationPrefix} ${topup.derivationSuffix}`, counterparty: topup.senderIdentityKey, forSelf: true
  })
  const own = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
  const [first, ...rest] = tx.outputs
  if (first?.lockingScript !== own || first.satoshis !== topup.satoshis) throw new Error('output 0 of the top-up does not pay this agent')
  if (!Number.isSafeInteger(first.satoshis) || first.satoshis <= 0 || first.satoshis > sats + maxBuffer()) throw new Error(`the top-up (${first.satoshis} sats) exceeds the price (${sats} sats) plus the fee buffer`)
  // Anything else is change back to the SAME allowance script
  if (rest.length > 1 || rest.some(o => o.lockingScript !== script)) throw new Error('the top-up sends allowance money elsewhere')

  // Sign the sighashes computed HERE, from the checked description
  return Promise.all(tx.inputs.map(async (_, i) => Utils.toHex(await s.signAllowance(sighashFor(tx, i)))))
}
