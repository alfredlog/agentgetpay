// Anchoring the audit log on BSV.
// We publish the fingerprint (hash) of one log entry in an OP_RETURN transaction.
// Since each entry contains the hash of the previous one, anchoring entry N
// "seals" entries 1 to N: changing any of them changes the hash of N.
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { Transaction, P2PKH, LockingScript, Utils, Broadcaster } from '../shared/bsv.js'
import { UtxoProvider } from '../shared/utxo.js'
import { Mutex } from '../shared/mutex.js'
import { getTxHex } from '../woc.js'
import type { LedgerEntry, Unlocker } from './types.js'
import { ArcadeBroadcaster } from '../shared/arcade.js'

const PROTOCOL = 'agentpay-v1'

export interface Anchor { seq: number; hash: string; txid: string; ts: string }

// ---- Data format on the blockchain: OP_FALSE OP_RETURN "agentpay-v1" <seq> <hash> ----
const push = (bytes: number[]) => Utils.toHex([bytes.length, ...bytes]) // pushes < 76 octets

export function anchorScript(seq: number, hash: string): LockingScript {
  const hex = '006a' + push(Utils.toArray(PROTOCOL, 'utf8')) + push(Utils.toArray(String(seq), 'utf8')) + push(Utils.toArray(hash, 'hex'))
  return LockingScript.fromHex(hex)
}

export function parseAnchorTx(rawHex: string): { seq: number; hash: string } | undefined {
  for (const out of Transaction.fromHex(rawHex).outputs) {
    const b = Utils.toArray(out.lockingScript.toHex(), 'hex')
    if (b[0] !== 0x00 || b[1] !== 0x6a) continue
    const parts: number[][] = []
    for (let i = 2; i < b.length;) { const n = b[i]; parts.push(b.slice(i + 1, i + 1 + n)); i += 1 + n }
    if (parts.length === 3 && Utils.toUTF8(parts[0]) === PROTOCOL) {
      return { seq: Number(Utils.toUTF8(parts[1])), hash: Utils.toHex(parts[2]) }
    }
  }
  return undefined
}

// ---- Local list of anchors (an index: the proof itself is on the blockchain) ----
export class AnchorLog {
  constructor(private path: string) { mkdirSync(dirname(path), { recursive: true }) }
  all(): Anchor[] {
    if (!existsSync(this.path)) return []
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  }
  add(a: Anchor) { appendFileSync(this.path, JSON.stringify(a) + '\n') }
  last() { return this.all().at(-1) }
}

// ---- Publishing on BSV ----
export class BsvAnchorRail {
  constructor(
    private address: string,
    private unlocker: () => Unlocker,
    private utxos: UtxoProvider & { remember(tx: Transaction): void },
    private lock: Mutex,
    private broadcaster: Broadcaster = new ArcadeBroadcaster()
  ) {}

  publish(seq: number, hash: string): Promise<string> {
    return this.lock.run(async () => {
      const utxo = await this.utxos.findUtxo(this.address, 100)
      if (!utxo) throw new Error('Not enough funds to anchor')
      const tx = new Transaction()
      tx.addInput({ sourceTransaction: utxo.sourceTransaction, sourceOutputIndex: utxo.outputIndex, unlockingScriptTemplate: this.unlocker() })
      tx.addOutput({ lockingScript: anchorScript(seq, hash), satoshis: 0 })
      tx.addOutput({ lockingScript: new P2PKH().lock(this.address), change: true })
      await tx.fee()
      await tx.sign()
      const r = await tx.broadcast(this.broadcaster)
      if (r.status !== 'success') throw new Error(`Anchor broadcast failed: ${JSON.stringify(r)}`)
      this.utxos.remember(tx)
      return tx.id('hex')
    })
  }
}

// ---- Independent verification: local log against the blockchain ----
export type FetchTxHex = (txid: string) => Promise<string>

const cache = new Map<string, string>() // a transaction never changes: read it only once
export const cachedWocFetch: FetchTxHex = async txid => {
  if (!cache.has(txid)) cache.set(txid, await getTxHex(txid))
  return cache.get(txid)!
}

const hashOf = (e: Omit<LedgerEntry, 'hash'>) => createHash('sha256').update(JSON.stringify(e)).digest('hex')

export interface ChainCheck {
  localOk: boolean        // the hash chain is consistent with itself
  localBrokenAt?: number
  chainOk: boolean        // anchored entries match the blockchain
  chainBrokenAt?: number  // first anchored entry that no longer matches
  anchoredUpTo: number    // last entry sealed on BSV
  unanchored: number      // entries not anchored yet
  anchors: number
}

export async function verifyAgainstChain(entries: LedgerEntry[], anchors: Anchor[], fetchHex: FetchTxHex): Promise<ChainCheck> {
  // 1. Local consistency
  let prev = '0'.repeat(64), localBrokenAt: number | undefined
  for (const e of entries) {
    const { hash, ...rest } = e
    if (e.prevHash !== prev || hashOf(rest) !== hash) { localBrokenAt = e.seq; break }
    prev = hash
  }
  // 2. Each anchor: the hash written on the blockchain must be the hash of the local entry
  const bySeq = new Map(entries.map(e => [e.seq, e]))
  let chainBrokenAt: number | undefined
  for (const a of anchors) {
    const onChain = parseAnchorTx(await fetchHex(a.txid))
    if (!onChain || onChain.seq !== a.seq || bySeq.get(a.seq)?.hash !== onChain.hash) { chainBrokenAt = a.seq; break }
  }
  const anchoredUpTo = anchors.at(-1)?.seq ?? 0
  return {
    localOk: localBrokenAt === undefined, localBrokenAt,
    chainOk: chainBrokenAt === undefined, chainBrokenAt,
    anchoredUpTo, unanchored: Math.max(0, (entries.at(-1)?.seq ?? 0) - anchoredUpTo),
    anchors: anchors.length
  }
}
