// Agent allowances: the company's money for an agent, locked on chain to the allowance script
// (agent AND proxy policy can spend; the company alone can reclaim). No server wallet holds it.
//
//   fund     the company (BSV Desktop) creates the output; the proxy checks the script, the amount
//            and the BEEF (SPV), then stores the UTXO with its BEEF ancestry (data/allowances.json)
//   topUp    when a purchase is allowed: the proxy spends the allowance just in time, one BRC-29 output
//            to the agent's wallet (price + fee buffer), change back to the SAME script, fee from the
//            allowance. The AGENT (its MCP server) checks and co-signs it through a step of /v1/fetch, the
//            proxy checks the agent's signatures, adds the policy signatures and broadcasts (Arcade, EF).
//            The agent wallet internalizes it on its side: the proxy holds no agent key.
//   reclaim  the company spends every UTXO back to its own wallet (BSV Desktop); the proxy marks it closed
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  Beef, LockingScript, P2PKH, PublicKey, Random, SatoshisPerKilobyte, Transaction, Utils,
  type Broadcaster, type ChainTracker, type WalletInterface
} from '../shared/bsv.js'
import { BRC29_PROTOCOL, type Brc29Payment } from '../shared/payments.js'
import type { KeyedMutex } from '../shared/mutex.js'
import type { AgentKeys } from './agent-keys.js'
import type { TopupInfo } from './agent-signer.js'
import {
  ALLOWANCE_PROTOCOL, AllowanceScript, companyKeyId, describeTx, policyKeyId, sighashFor, verifyHashSignature, walletPubKey, walletSigner,
  type AllowanceKeys, type TxDescription
} from './script.js'

export interface AllowanceUtxo { txid: string; vout: number; satoshis: number; beef: string /* AtomicBEEF, hex */ }
export interface Allowance {
  agentId: string
  status: 'open' | 'closed'
  keys: AllowanceKeys
  lockingScript: string
  utxos: AllowanceUtxo[]
  createdAt: string
  closedAt?: string
  reclaimTxid?: string
}

// What the admin page needs to build or reclaim an allowance
export interface AllowanceView {
  agentId: string
  status: 'open' | 'closed' | 'none'
  balanceSats: number
  utxos: { txid: string; vout: number; satoshis: number }[]
  beef?: string // merged BEEF (hex) of the UTXOs, as inputBEEF for the reclaim
  lockingScript?: string
  protocolID: typeof ALLOWANCE_PROTOCOL
  companyKeyID: string
}

export class AllowanceEmpty extends Error {
  constructor(have: number, need: number) {
    super(`allowance empty: ask the company to top up (${have} sats left in the allowance, ${need} sats needed)`)
  }
}

class AllowanceStore {
  constructor(private path: string) { mkdirSync(dirname(path), { recursive: true }) }
  private read(): Record<string, Allowance> { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {} }
  get(agentId: string): Allowance | undefined { return this.read()[agentId] }
  all(): Allowance[] { return Object.values(this.read()) }
  put(a: Allowance) {
    const all = this.read(); all[a.agentId] = a
    writeFileSync(`${this.path}.tmp`, JSON.stringify(all, null, 2))
    renameSync(`${this.path}.tmp`, this.path) // atomic: a crash never leaves half a file
  }
}

export interface AllowanceDeps {
  file?: string
  policyWallet: () => Promise<WalletInterface>
  agentKeys: (agentId: string) => AgentKeys | undefined // registered by the agent itself
  chainTracker: () => Promise<ChainTracker>
  broadcaster: () => Promise<Broadcaster>
  lock: KeyedMutex // per agent
  eurPerSat: number
  record: (e: { agentId: string; url: string; amountSats: number; amountEur: number; decision: 'admin'; action: string; txid?: string; reason: string; approvedBy?: string }) => Promise<unknown>
  feeSatPerKb?: number   // fee rate of the top-up transactions
  feeBufferSats?: number // added to each top-up: the agent wallet pays the BRC-121 payment's own fee
}

// Asks the agent to check and co-sign a top-up: returns one DER signature (hex) per input
export type Cosign = (tx: TxDescription, sighashes: string[], topup: TopupInfo) => Promise<string[]>

const sum = (u: { satoshis: number }[]) => u.reduce((s, x) => s + x.satoshis, 0)

export function createAllowances(d: AllowanceDeps) {
  const store = new AllowanceStore(d.file ?? 'data/allowances.json')
  const template = new AllowanceScript()
  const feeModel = new SatoshisPerKilobyte(d.feeSatPerKb ?? Number(process.env.ALLOWANCE_FEE_SAT_PER_KB ?? 100))
  const buffer = d.feeBufferSats ?? Number(process.env.ALLOWANCE_FEE_BUFFER_SATS ?? 200)
  const eur = (sats: number) => sats * d.eurPerSat

  // agentPub and policyPub of an agent's allowance (the company adds its own derived key)
  async function keys(agentId: string) {
    const agentPub = d.agentKeys(agentId)?.allowancePubKey
    if (!agentPub) throw new Error(`Agent ${agentId} has not registered its key yet: start its MCP server once (it registers automatically)`)
    const policyPub = await walletPubKey(await d.policyWallet(), policyKeyId(agentId))
    return { agentPub, policyPub, protocolID: ALLOWANCE_PROTOCOL, companyKeyID: companyKeyId(agentId) }
  }

  const balance = (agentId: string) => {
    const a = store.get(agentId)
    return a?.status === 'open' ? sum(a.utxos) : 0
  }

  function view(agentId: string): AllowanceView {
    const a = store.get(agentId)
    const base = { agentId, protocolID: ALLOWANCE_PROTOCOL, companyKeyID: companyKeyId(agentId) }
    if (!a) return { ...base, status: 'none', balanceSats: 0, utxos: [] }
    const open = a.status === 'open'
    const beef = new Beef()
    if (open) for (const u of a.utxos) beef.mergeBeef(Utils.toArray(u.beef, 'hex'))
    return {
      ...base, status: a.status, balanceSats: open ? sum(a.utxos) : 0, lockingScript: a.lockingScript,
      utxos: open ? a.utxos.map(({ txid, vout, satoshis }) => ({ txid, vout, satoshis })) : [],
      ...(open && a.utxos.length ? { beef: Utils.toHex(beef.toBinary()) } : {})
    }
  }

  // ---- Funding by the company: check the script, the amount and the BEEF, then store the UTXO ----
  const fund = (agentId: string, f: { beef: number[]; outputIndex: number; companyPub: string }, by?: string) => d.lock.for(agentId).run(async () => {
    if (!Array.isArray(f.beef) || !f.beef.length || f.beef.length > 10_000_000) throw new Error('beef must be an AtomicBEEF byte array')
    const tx = Transaction.fromAtomicBEEF(f.beef)
    const out = tx.outputs[f.outputIndex]
    if (!Number.isSafeInteger(f.outputIndex) || !out) throw new Error('outputIndex does not exist in the transaction')
    const k = await keys(agentId)
    const lockingScript = template.lock({ agentPub: k.agentPub, policyPub: k.policyPub, companyPub: String(f.companyPub) }).toHex()
    if (out.lockingScript.toHex() !== lockingScript) throw new Error('The output is not locked to this agent\'s allowance script')
    const sats = out.satoshis ?? 0
    if (!Number.isSafeInteger(sats) || sats < 1000) throw new Error('An allowance needs at least 1000 sats')
    if (!(await tx.verify(await d.chainTracker()))) throw new Error('The funding transaction failed SPV verification')
    const txid = tx.id('hex')
    const prev = store.get(agentId)
    if (prev?.status === 'open' && prev.lockingScript !== lockingScript) throw new Error('This agent already has an open allowance with another company key: reclaim it first')
    if (prev?.status === 'open' && prev.utxos.some(u => u.txid === txid && u.vout === f.outputIndex)) throw new Error('This funding is already recorded')
    const keysOf: AllowanceKeys = { agentPub: k.agentPub, policyPub: k.policyPub, companyPub: String(f.companyPub) }
    const utxo: AllowanceUtxo = { txid, vout: f.outputIndex, satoshis: sats, beef: Utils.toHex(f.beef) }
    store.put(prev?.status === 'open'
      ? { ...prev, utxos: [...prev.utxos, utxo] }
      : { agentId, status: 'open', keys: keysOf, lockingScript, utxos: [utxo], createdAt: new Date().toISOString() })
    await d.record({ agentId, url: `allowance://${agentId}/fund`, amountSats: sats, amountEur: eur(sats), decision: 'admin', action: 'allowance_fund', txid, approvedBy: by, reason: `Allowance funded by the company: ${sats} sats` })
    return view(agentId)
  })

  // ---- Just-in-time top-up: the agent wallet must hold `amountSats` + fee buffer ----
  // `walletSats` is what the agent says its wallet holds (only the missing part is sent). `cosign` asks the
  // agent for its signatures of the top-up; they are checked here against the registered agentPub.
  // Returns the BRC-29 payment the agent internalizes, or undefined if its wallet already holds enough.
  const ensureFunds = (agentId: string, amountSats: number, forUrl: string, walletSats: number, cosign: Cosign) => d.lock.for(agentId).run(async (): Promise<Brc29Payment | undefined> => {
    const need = amountSats + buffer
    const missing = need - Math.max(0, Number.isSafeInteger(walletSats) ? walletSats : 0)
    if (missing <= 0) return undefined // refunds or a previous buffer already cover it

    const a = store.get(agentId)
    const utxos = a?.status === 'open' ? [...a.utxos].sort((x, y) => y.satoshis - x.satoshis) : []
    if (!a || !utxos.length) throw new AllowanceEmpty(0, missing)

    // BRC-29 output to the agent: derived by the policy wallet (sender) for the agent's identity key
    const policyWallet = await d.policyWallet()
    const policyIdentity = (await policyWallet.getPublicKey({ identityKey: true })).publicKey
    const agentIdentity = d.agentKeys(agentId)?.identityKey
    if (!agentIdentity) throw new Error(`Agent ${agentId} has not registered its keys`)
    const derivationPrefix = Utils.toBase64(Random(16))
    const derivationSuffix = Utils.toBase64(Random(16))
    const { publicKey } = await policyWallet.getPublicKey({ protocolID: BRC29_PROTOCOL, keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: agentIdentity, forSelf: false })

    // Inputs: the largest UTXOs first, until they cover the top-up and the fee.
    // The agent's signatures are only known after the fee is set: they come from `agentSigs` below.
    const agentSigs = new Map<string, number[]>()
    const unlock = template.unlock(async h => {
      const sig = agentSigs.get(Utils.toHex(h))
      if (!sig) throw new Error('missing agent signature')
      return sig
    }, walletSigner(policyWallet, policyKeyId(agentId)))
    const build = async (inputs: AllowanceUtxo[]) => {
      const tx = new Transaction()
      for (const u of inputs) tx.addInput({ sourceTransaction: Transaction.fromAtomicBEEF(Utils.toArray(u.beef, 'hex')), sourceOutputIndex: u.vout, unlockingScriptTemplate: unlock })
      tx.addOutput({ lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()), satoshis: missing })
      tx.addOutput({ lockingScript: LockingScript.fromHex(a.lockingScript), change: true }) // change back to the SAME allowance script
      return tx
    }
    let chosen: AllowanceUtxo[] = []
    let tx: Transaction | undefined
    for (const u of utxos) {
      chosen = [...chosen, u]
      const t = await build(chosen)
      if (sum(chosen) >= missing + await feeModel.computeFee(t)) { tx = t; break }
    }
    if (!tx) throw new AllowanceEmpty(sum(utxos), missing)
    await tx.fee(feeModel)

    // The agent co-signs: one signature per input, each checked against the registered agentPub
    const description = describeTx(tx)
    const hashes = description.inputs.map((_, i) => sighashFor(description, i))
    const topup: TopupInfo = { satoshis: missing, derivationPrefix, derivationSuffix, senderIdentityKey: policyIdentity }
    const sigs = await cosign(description, hashes.map(h => Utils.toHex(h)), topup)
    if (!Array.isArray(sigs) || sigs.length !== hashes.length) throw new Error('The agent did not sign every input of the top-up')
    hashes.forEach((h, i) => {
      const der = /^[0-9a-f]{16,200}$/.test(String(sigs[i])) ? Utils.toArray(sigs[i], 'hex') : []
      if (!verifyHashSignature(a.keys.agentPub, h, der)) throw new Error(`Invalid agent signature for input ${i} of the top-up`)
      agentSigs.set(Utils.toHex(h), der)
    })
    await tx.sign() // agent (checked above) AND policy signatures on every allowance input
    const r = await tx.broadcast(await d.broadcaster())
    if (r.status !== 'success' && !/already|known/i.test(JSON.stringify(r))) throw new Error(`Allowance top-up rejected by the network: ${JSON.stringify(r).slice(0, 200)}`)

    // Broadcast: the old UTXOs are spent. Store the change (with its ancestry) BEFORE anything else can fail.
    const txid = tx.id('hex')
    const atomic = tx.toAtomicBEEF()
    const changeIndex = tx.outputs.findIndex((o, i) => i > 0 && o.lockingScript.toHex() === a.lockingScript)
    const spent = new Set(chosen.map(u => `${u.txid}.${u.vout}`))
    const left = a.utxos.filter(u => !spent.has(`${u.txid}.${u.vout}`))
    if (changeIndex > 0) left.push({ txid, vout: changeIndex, satoshis: tx.outputs[changeIndex].satoshis ?? 0, beef: Utils.toHex(atomic) })
    store.put({ ...a, utxos: left })
    await d.record({ agentId, url: forUrl, amountSats: missing, amountEur: eur(missing), decision: 'admin', action: 'allowance_topup', txid, reason: `Allowance top-up: ${missing} sats to the agent wallet (${sum(left)} sats left)` })

    // The agent wallet receives it on the agent's side (spendable at once)
    return { tx: Array.from(atomic), txid, outputIndex: 0, satoshis: missing, derivationPrefix, derivationSuffix, senderIdentityKey: policyIdentity }
  })

  // ---- Reclaim by the company: the transaction must spend every UTXO of the allowance ----
  const reclaimed = (agentId: string, beef: number[], by?: string) => d.lock.for(agentId).run(async () => {
    const a = store.get(agentId)
    if (!a || a.status !== 'open') throw new Error('No open allowance for this agent')
    if (!Array.isArray(beef) || !beef.length) throw new Error('beef must be an AtomicBEEF byte array')
    const tx = Transaction.fromAtomicBEEF(beef)
    const spends = new Set(tx.inputs.map(i => `${i.sourceTXID ?? i.sourceTransaction?.id('hex')}.${i.sourceOutputIndex}`))
    const missing = a.utxos.filter(u => !spends.has(`${u.txid}.${u.vout}`))
    if (missing.length) throw new Error(`The reclaim does not spend ${missing.length} allowance output(s)`)
    if (!(await tx.verify(await d.chainTracker()))) throw new Error('The reclaim transaction failed verification')
    const txid = tx.id('hex')
    const sats = sum(a.utxos)
    store.put({ ...a, status: 'closed', utxos: [], closedAt: new Date().toISOString(), reclaimTxid: txid })
    await d.record({ agentId, url: `allowance://${agentId}/reclaim`, amountSats: sats, amountEur: eur(sats), decision: 'admin', action: 'allowance_reclaim', txid, approvedBy: by, reason: `Allowance reclaimed by the company: ${sats} sats` })
    return view(agentId)
  })

  return { keys, balance, view, fund, ensureFunds, reclaimed }
}
export type Allowances = ReturnType<typeof createAllowances>
