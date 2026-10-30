// The agent "allowance": an on-chain output that no single key controls.
//
//   OP_IF   <agentPub> OP_CHECKSIGVERIFY <policyPub> OP_CHECKSIG     agent AND proxy policy
//   OP_ELSE <companyPub> OP_CHECKSIG                                 the company alone (reclaim)
//   OP_ENDIF
//
//   spend by agent + policy:  <sigPolicy> <sigAgent> OP_1
//   reclaim by the company:   <sigCompany> OP_0
//
// Signatures are SIGHASH_ALL|FORKID over the BIP-143 preimage of the FULL locking script, and are
// made by the wallets with createSignature({ hashToDirectlySign }) (guide Appendix A client/signer.ts):
// no private key ever leaves a wallet. Every key is a DERIVED key, never an identity key (guide §5.1).
import {
  Hash, LockingScript, OP, Signature, TransactionSignature, UnlockingScript, Utils,
  type ScriptTemplate, type ScriptTemplateUnlock, type Transaction, type WalletInterface, type WalletProtocol
} from '../shared/bsv.js'

// Security level 1: BSV Desktop asks the company once for this app (AGENTS.md: level ≥ 1 for keys that control value)
export const ALLOWANCE_PROTOCOL: WalletProtocol = [1, 'agentgetpay allowance']
export const companyKeyId = (agentId: string) => `agent-${agentId}`
export const policyKeyId = (agentId: string) => `policy-${agentId}`
export const AGENT_KEY_ID = 'agent'

const SCOPE = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID
// A checksig signature push is at most 1 + 73 bytes (DER ≤ 72 + sighash byte)
export const SPEND_UNLOCK_LENGTH = 2 * 74 + 1 // <sigPolicy> <sigAgent> OP_1
export const RECLAIM_UNLOCK_LENGTH = 74 + 1   // <sigCompany> OP_0

// Signs a 32-byte sighash and returns the DER signature. The key stays where it is.
export type HashSigner = (hash: number[]) => Promise<number[]>

// A derived key of a BRC-100 wallet, used as a HashSigner (counterparty 'self')
export const walletSigner = (wallet: WalletInterface, keyID: string, originator?: string): HashSigner => async hash => {
  const { signature } = await wallet.createSignature({ hashToDirectlySign: hash, protocolID: ALLOWANCE_PROTOCOL, keyID, counterparty: 'self' }, originator)
  return Array.from(signature)
}
export const walletPubKey = async (wallet: WalletInterface, keyID: string, originator?: string): Promise<string> =>
  (await wallet.getPublicKey({ protocolID: ALLOWANCE_PROTOCOL, keyID, counterparty: 'self' }, originator)).publicKey

// BIP-143 sighash of one input, over the full source locking script
export function sighash(tx: Transaction, inputIndex: number): number[] {
  const input = tx.inputs[inputIndex]
  const sourceTx = input.sourceTransaction
  if (sourceTx === undefined) throw new Error(`input ${inputIndex} has no source transaction`)
  const source = sourceTx.outputs[input.sourceOutputIndex]
  const preimage = TransactionSignature.format({
    sourceTXID: input.sourceTXID ?? sourceTx.id('hex'),
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: source.satoshis!,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
    inputIndex,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: source.lockingScript,
    lockTime: tx.lockTime,
    scope: SCOPE
  })
  return Hash.hash256(preimage)
}

// DER signature from a wallet → checksig format (DER + sighash byte)
const checksig = (der: number[]) => {
  const sig = Signature.fromDER(der)
  return new TransactionSignature(sig.r, sig.s, SCOPE).toChecksigFormat()
}
const push = (data: number[]) => ({ op: data.length, data })

export interface AllowanceKeys { agentPub: string; policyPub: string; companyPub: string }

export class AllowanceScript implements ScriptTemplate {
  lock (k: AllowanceKeys): LockingScript {
    for (const [name, key] of Object.entries(k)) if (!/^0[23][0-9a-f]{64}$/.test(key)) throw new Error(`${name} is not a compressed public key`)
    if (new Set(Object.values(k)).size !== 3) throw new Error('The three allowance keys must be different')
    return new LockingScript([
      { op: OP.OP_IF },
      push(Utils.toArray(k.agentPub, 'hex')), { op: OP.OP_CHECKSIGVERIFY },
      push(Utils.toArray(k.policyPub, 'hex')), { op: OP.OP_CHECKSIG },
      { op: OP.OP_ELSE },
      push(Utils.toArray(k.companyPub, 'hex')), { op: OP.OP_CHECKSIG },
      { op: OP.OP_ENDIF }
    ])
  }

  // Agent + proxy policy: both must sign
  unlock (agent: HashSigner, policy: HashSigner): ScriptTemplateUnlock {
    return {
      sign: async (tx, inputIndex) => {
        const h = sighash(tx, inputIndex)
        const [sigAgent, sigPolicy] = await Promise.all([agent(h), policy(h)])
        return new UnlockingScript([push(checksig(sigPolicy)), push(checksig(sigAgent)), { op: OP.OP_1 }])
      },
      estimateLength: async () => SPEND_UNLOCK_LENGTH
    }
  }

  // The company alone, back to its own wallet
  unlockReclaim (company: HashSigner): ScriptTemplateUnlock {
    return {
      sign: async (tx, inputIndex) => new UnlockingScript([push(checksig(await company(sighash(tx, inputIndex)))), { op: OP.OP_0 }]),
      estimateLength: async () => RECLAIM_UNLOCK_LENGTH
    }
  }
}
