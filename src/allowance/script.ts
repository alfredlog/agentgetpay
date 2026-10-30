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
  BigNumber, ECDSA, Hash, LockingScript, OP, PublicKey, Signature, TransactionSignature, UnlockingScript, Utils,
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

// A transaction reduced to what BIP-143 signs: for each input its outpoint, amount, script and
// sequence; the outputs; version and lock time. The proxy sends this to the agent for co-signing,
// and the agent recomputes the sighashes from it (it never signs a hash it cannot check).
export interface TxDescription {
  version: number
  lockTime: number
  inputs: { txid: string; vout: number; satoshis: number; lockingScript: string; sequence: number }[]
  outputs: { satoshis: number; lockingScript: string }[]
}

export function describeTx(tx: Transaction): TxDescription {
  return {
    version: tx.version,
    lockTime: tx.lockTime,
    inputs: tx.inputs.map((input, i) => {
      const sourceTx = input.sourceTransaction
      if (sourceTx === undefined) throw new Error(`input ${i} has no source transaction`)
      const source = sourceTx.outputs[input.sourceOutputIndex]
      return { txid: input.sourceTXID ?? sourceTx.id('hex'), vout: input.sourceOutputIndex, satoshis: source.satoshis!, lockingScript: source.lockingScript.toHex(), sequence: input.sequence ?? 0xffffffff }
    }),
    outputs: tx.outputs.map(o => ({ satoshis: o.satoshis!, lockingScript: o.lockingScript.toHex() }))
  }
}

// BIP-143 sighash of one input, over the full source locking script
export function sighashFor(d: TxDescription, inputIndex: number): number[] {
  const input = d.inputs[inputIndex]
  if (input === undefined) throw new Error(`input ${inputIndex} does not exist`)
  const refs = d.inputs.map(i => ({ sourceTXID: i.txid, sourceOutputIndex: i.vout, sequence: i.sequence }))
  const preimage = TransactionSignature.format({
    sourceTXID: input.txid,
    sourceOutputIndex: input.vout,
    sourceSatoshis: input.satoshis,
    transactionVersion: d.version,
    otherInputs: refs.filter((_, i) => i !== inputIndex) as Parameters<typeof TransactionSignature.format>[0]['otherInputs'],
    inputIndex,
    outputs: d.outputs.map(o => ({ satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.lockingScript) })),
    inputSequence: input.sequence,
    subscript: LockingScript.fromHex(input.lockingScript),
    lockTime: d.lockTime,
    scope: SCOPE
  })
  return Hash.hash256(preimage)
}
export const sighash = (tx: Transaction, inputIndex: number) => sighashFor(describeTx(tx), inputIndex)

// Checks a DER signature of a 32-byte hash (made with hashToDirectlySign) against a public key
export function verifyHashSignature(publicKey: string, hash: number[], der: number[]): boolean {
  try {
    return ECDSA.verify(new BigNumber(hash), Signature.fromDER(der), PublicKey.fromString(publicKey))
  } catch { return false }
}

// What the agent signs with its allowance key when it registers its keys with the proxy (proof of possession)
export const registrationHash = (agentId: string, identityKey: string, allowancePubKey: string) =>
  Hash.sha256(Utils.toArray(`agentgetpay agent keys\n${agentId}\n${identityKey}\n${allowancePubKey}`, 'utf8'))

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
