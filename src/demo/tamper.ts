// DÉMO : un tricheur "intelligent" qui a accès au serveur.
// Il change le montant d'une entrée, puis RECALCULE toutes les empreintes suivantes
// pour que la chaîne locale reste cohérente. Seul l'ancrage sur BSV peut le démasquer.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const SEQ = Number(process.argv[2] ?? 2)
const path = 'data/ledger.jsonl'
const entries = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const target = entries.find(e => e.seq === SEQ)
if (!target) throw new Error(`No entry #${SEQ} in the audit log`)

console.log(`Entry #${SEQ} before: ${target.agentId} paid €${target.amountEur.toFixed(2)}`)
target.amountSats = 1
target.amountEur = 0.01
target.purpose = 'Nothing to see here'

let prev = '0'.repeat(64)
for (const e of entries) {
  e.prevHash = prev
  const { hash, ...rest } = e
  e.hash = createHash('sha256').update(JSON.stringify(rest)).digest('hex')
  prev = e.hash
}
writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
console.log(`Entry #${SEQ} after : ${target.agentId} paid €0.01`)
console.log(`Recomputed the hashes of all ${entries.length} entries — the local chain looks perfect.`)
console.log('Now run: npm run ledger:verify')
