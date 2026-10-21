// Journal d'audit "append-only" : chaque ligne contient le hash de la précédente.
// Modifier une ancienne ligne casse toute la chaîne après elle → la fraude se voit.
// Étape suivante : ancrer le dernier hash sur BSV pour rendre la preuve publique.
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { Ledger, LedgerEntry } from './types.js'

const GENESIS = '0'.repeat(64)
const hashOf = (e: Omit<LedgerEntry, 'hash'>) =>
  createHash('sha256').update(JSON.stringify(e)).digest('hex')

export class JsonlLedger implements Ledger {
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true }) // crée le dossier data/ s'il manque
  }

  async all(): Promise<LedgerEntry[]> {
    return this.allSync()
  }

  allSync(): LedgerEntry[] {
    if (!existsSync(this.path)) return []
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  }

  async record(e: Omit<LedgerEntry, 'seq' | 'ts' | 'prevHash' | 'hash'>) {
    const entries = await this.all()
    const last = entries.at(-1)
    const base = { seq: (last?.seq ?? 0) + 1, ts: new Date().toISOString(), ...e, prevHash: last?.hash ?? GENESIS }
    const entry: LedgerEntry = { ...base, hash: hashOf(base) }
    appendFileSync(this.path, JSON.stringify(entry) + '\n')
    return entry
  }

  async verify() {
    let prev = GENESIS
    for (const e of await this.all()) {
      const { hash, ...rest } = e
      if (e.prevHash !== prev || hashOf(rest) !== hash) return { ok: false, brokenAt: e.seq }
      prev = hash
    }
    return { ok: true }
  }
}
