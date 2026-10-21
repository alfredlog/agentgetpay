// Démo : l'agent "docs-01" utilise PDF Libre comme service payant, via le proxy.
// Il n'a aucune clé : il envoie ses PDF au proxy, qui applique les règles et paie PDF Libre.
//
// Usage : npm run agent:pdf                         → avec deux PDF d'exemple générés
//         npm run agent:pdf -- facture.pdf contrat.pdf → avec tes propres fichiers
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename } from 'node:path'

const PROXY = process.env.PROXY_URL ?? 'http://localhost:5050'
const PDF_LIBRE = process.env.PDF_LIBRE_URL ?? 'http://localhost:3000'
const API_KEY = 'dev-docs-01'

// ---- Petite PDF d'exemple écrite à la main (pas besoin de bibliothèque) ----
function samplePdf(title: string, pages: number): Buffer {
  const objs: string[] = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  const kids: string[] = []
  for (let i = 0; i < pages; i++) {
    const page = 4 + 2 * i, content = 5 + 2 * i
    const lines = Array.from({ length: 30 }, (_, l) => `0 -20 Td (${title}, page ${i + 1}, line ${l + 1}: sample text for the demo.) Tj`)
    const stream = `BT /F1 12 Tf 60 780 Td ${lines.join(' ')} ET`
    objs[content] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    objs[page] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`
    kids.push(`${page} 0 R`)
  }
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let n = 1; n < objs.length; n++) { offsets[n] = out.length; out += `${n} 0 obj\n${objs[n]}\nendobj\n` }
  const xref = out.length
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

// ---- Appel d'un service à travers le proxy ----
async function call(path: string, body: object | undefined, purpose: string) {
  const res = await fetch(`${PROXY}/v1/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ url: `${PDF_LIBRE}${path}`, method: body ? 'POST' : 'GET', body, purpose })
  })
  const data = await res.json() as any
  const paid = Number(res.headers.get('X-Paid-Sats') ?? 0)
  return { ok: res.ok, status: res.status, paid, data }
}

const files = process.argv.slice(2)
const pdfA = files[0] ? readFileSync(files[0]) : samplePdf('Invoice 2026-10', 3)
const pdfB = files[1] ? readFileSync(files[1]) : samplePdf('Service contract', 2)
const nameA = files[0] ? basename(files[0]) : 'Invoice.pdf'
mkdirSync('data/out', { recursive: true })
const save = (d: any) => { writeFileSync(`data/out/${d.filename}`, Buffer.from(d.pdf, 'base64')); return `data/out/${d.filename}` }
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`

// 1. Découverte : quels outils, quels prix ? (gratuit)
const menu = await call('/agent/v1', undefined, 'Discover tools and prices')
if (!menu.ok) throw new Error(`PDF Libre unreachable through the proxy: ${JSON.stringify(menu.data)}`)
console.log('PDF Libre tools:', menu.data.tools.map((t: any) => `${t.path} (${t.price} sats)`).join(', '), '\n')

// 2. Compresser : sous le seuil de validation → payé automatiquement
const c = await call('/agent/v1/compress', { pdf: pdfA.toString('base64'), filename: nameA }, 'Compress the invoice before emailing it')
console.log(c.ok
  ? `✔ compress  paid ${c.paid} sats  ${kb(c.data.originalSize)} → ${kb(c.data.resultSize)}  saved ${save(c.data)}`
  : `✘ compress  ${c.status}  ${c.data.reason ?? c.data.error}`)

// 3. Fusionner : au-dessus du seuil → validation humaine sur Telegram
console.log('… merge costs more than the approval threshold: check your phone')
const m = await call('/agent/v1/merge', { pdfs: [pdfA.toString('base64'), pdfB.toString('base64')], filename: nameA }, 'Merge invoice and contract for the client file')
console.log(m.ok
  ? `✔ merge     paid ${m.paid} sats  ${m.data.inputs} files  saved ${save(m.data)}`
  : `✘ merge     ${m.status}  ${m.data.reason ?? m.data.error}`)

// 4. Fichier abîmé : PDF Libre refuse le travail, l'agent ne paie rien
const broken = Buffer.from('%PDF-1.4\nthis file is damaged')
const b = await call('/agent/v1/compress', { pdf: broken.toString('base64'), filename: 'damaged.pdf' }, 'Compress a damaged file')
console.log(b.ok ? `? damaged file was accepted` : `✘ damaged   ${b.data.reason ?? b.data.error}`)
