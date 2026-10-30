// The PROXY's record of each agent's public keys, registered by the agent itself (its MCP server, with its
// API key, on first start): the allowance key (agentPub in the allowance script) and the identity key
// (BRC-29 recipient of the top-ups). Only public keys: the agent's private key never reaches the proxy.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Utils } from '../shared/bsv.js'
import { registrationHash, verifyHashSignature } from './script.js'

export interface AgentKeys { identityKey: string; allowancePubKey: string; registeredAt: string }

const pubKey = /^0[23][0-9a-f]{64}$/

export class AgentKeyStore {
  constructor(private path = 'data/agent-keys.json') { mkdirSync(dirname(path), { recursive: true }) }
  private read(): Record<string, AgentKeys> { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {} }
  get(agentId: string): AgentKeys | undefined { return this.read()[agentId] }

  // Checks the proof (the allowance key signed the registration) and stores the keys.
  // Returns 'same' if nothing changed. `locked`: the agent has an open allowance, its key cannot change.
  register(agentId: string, b: { identityKey?: unknown; allowancePubKey?: unknown; proof?: unknown }, locked: boolean): 'new' | 'changed' | 'same' {
    const identityKey = String(b.identityKey ?? ''), allowancePubKey = String(b.allowancePubKey ?? ''), proof = String(b.proof ?? '')
    if (!pubKey.test(identityKey) || !pubKey.test(allowancePubKey)) throw new Error('identityKey and allowancePubKey must be compressed public keys')
    if (identityKey === allowancePubKey) throw new Error('The allowance key must be a derived key, not the identity key')
    if (!/^[0-9a-f]{16,200}$/.test(proof) || !verifyHashSignature(allowancePubKey, registrationHash(agentId, identityKey, allowancePubKey), Utils.toArray(proof, 'hex'))) {
      throw new Error('The proof is not a signature of these keys by the allowance key')
    }
    const all = this.read()
    const prev = all[agentId]
    if (prev && prev.identityKey === identityKey && prev.allowancePubKey === allowancePubKey) return 'same'
    if (prev && locked) throw new Error('This agent has an open allowance locked to its current key: the company must reclaim it before the agent key can change')
    all[agentId] = { identityKey, allowancePubKey, registeredAt: new Date().toISOString() }
    writeFileSync(`${this.path}.tmp`, JSON.stringify(all, null, 2))
    renameSync(`${this.path}.tmp`, this.path)
    return prev ? 'changed' : 'new'
  }
}
