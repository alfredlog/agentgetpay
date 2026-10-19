// Vérification INDÉPENDANTE du journal, comme le ferait un auditeur :
// 1. la chaîne de hashes locale est-elle cohérente ?
// 2. les entrées ancrées correspondent-elles aux preuves publiées sur BSV ?
import { JsonlLedger } from './ledger.js'
import { AnchorLog, verifyAgainstChain, cachedWocFetch } from './anchor.js'

const entries = await new JsonlLedger('data/ledger.jsonl').all()
const anchors = new AnchorLog('data/anchors.jsonl').all()
let r: Awaited<ReturnType<typeof verifyAgainstChain>>
try {
  r = await verifyAgainstChain(entries, anchors, cachedWocFetch)
} catch (e) {
  console.error(`✘ Could not read the anchors from the blockchain: ${(e as Error).message}`)
  console.error('  Check your internet connection, or wait a few seconds if the anchor was just published.')
  process.exit(1)
}

console.log(`${entries.length} entries, ${anchors.length} anchor(s) on BSV\n`)
console.log(`Local hash chain : ${r.localOk ? 'consistent ✔' : `BROKEN at entry #${r.localBrokenAt} ✘`}`)
if (!anchors.length) console.log('BSV anchors      : none yet (run npm run anchor)')
else console.log(`BSV anchors      : ${r.chainOk ? `match ✔ (entries #1–#${r.anchoredUpTo} sealed on-chain)` : `MISMATCH ✘ — entries up to #${r.chainBrokenAt} were altered after anchoring`}`)
if (r.unanchored) console.log(`Not anchored yet : ${r.unanchored} entr${r.unanchored > 1 ? 'ies' : 'y'}`)
console.log(`\nVerdict: ${r.localOk && r.chainOk ? 'AUDIT LOG INTACT ✔' : 'AUDIT LOG TAMPERED ✘'}`)
