// Exporte les paiements d'un mois au format DATEV (Buchungsstapel).
// Usage : npm run export:datev            → mois en cours
//         npm run export:datev -- 2026-10 → un mois précis
import { mkdirSync, writeFileSync } from 'node:fs'
import { JsonlLedger } from './ledger.js'
import { DatevExporter, loadAccountingConfig, paidInMonth } from './accounting.js'

const month = process.argv[2] ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 7)
const entries = await new JsonlLedger('data/ledger.jsonl').all()
const { filename, content } = new DatevExporter(loadAccountingConfig()).exportMonth(entries, month)
const paid = paidInMonth(entries, month)

mkdirSync('data/exports', { recursive: true })
writeFileSync(`data/exports/${filename}`, content, 'latin1') // DATEV lit en général l'encodage Windows (ANSI)
console.log(`${paid.length} payment(s), total €${paid.reduce((s, e) => s + e.amountEur, 0).toFixed(2)}`)
console.log(`DATEV file: data/exports/${filename}`)
