// The agent's side of the allowance: its own wallet-toolbox wallet. It co-signs allowance spends
// (with the proxy's policy key), receives the top-ups, pays merchants with BRC-121 and receives refunds.
//
// LIMITATION (this branch): LocalAgentSigners runs inside the proxy process, with one key file and one
// wallet file per agent. Whoever controls the proxy host can therefore use both the agent key and the
// policy key. A later branch moves the AgentSigner to the agent side (MCP server), so that the proxy
// alone can no longer spend an allowance. The rest of the code only knows the AgentSigner interface.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { WalletInterface } from '../shared/bsv.js'
import { openServerWallet } from '../shared/wallet.js'
import { AGENT_KEY_ID, walletPubKey, walletSigner, type HashSigner } from './script.js'

export interface AgentSigner {
  wallet(): Promise<WalletInterface>   // BRC-121 payer; receives top-ups and refunds
  identityKey(): Promise<string>       // BRC-29 recipient of the top-ups
  allowancePubKey(): Promise<string>   // agentPub in the allowance script (a derived key)
  signAllowance: HashSigner            // co-signs an allowance spend
}

export interface AgentSigners { get(agentId: string): AgentSigner }

export class LocalAgentSigners implements AgentSigners {
  private wallets = new Map<string, Promise<WalletInterface>>()
  constructor(private dir = process.env.AGENT_WALLETS_DIR ?? 'data/agents') {}

  get(agentId: string): AgentSigner {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(agentId)) throw new Error('Invalid agent id')
    const wallet = () => {
      let w = this.wallets.get(agentId)
      if (!w) { w = this.open(agentId); this.wallets.set(agentId, w); w.catch(() => this.wallets.delete(agentId)) }
      return w
    }
    return {
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
