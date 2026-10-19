// Export comptable : transforme les paiements du journal d'audit en écritures pour DATEV,
// le logiciel utilisé par presque tous les comptables allemands.
// Format : "Buchungsstapel" (EXTF), version simplifiée avec les colonnes principales.
// ⚠ À faire valider par un conseiller fiscal et par un import test dans DATEV avant un usage réel.
import { readFileSync } from 'node:fs'
import type { LedgerEntry } from './types.js'
import type { Anchor } from './anchor.js'

export interface AccountingConfig {
  companyName: string
  consultantNumber: number // Beraternummer
  clientNumber: number     // Mandantennummer
  chartOfAccounts: string  // SKR03 ou SKR04
  expenseAccount: string   // compte de charges (Konto)
  walletAccount: string    // compte du portefeuille (Gegenkonto)
}

export const loadAccountingConfig = (path = 'config/accounting.json'): AccountingConfig =>
  JSON.parse(readFileSync(path, 'utf8'))

// Interface : en version entreprise, on ajoute un exportateur XRechnung ou SAP sans toucher au reste
export interface AccountingExporter {
  exportMonth(entries: LedgerEntry[], month: string): { filename: string; content: string }
}

// ---- Helpers ----
const TZ = 'Europe/Berlin'
const berlin = (ts: string | Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date(ts)).map(x => [x.type, x.value]))
  return { y: p.year, m: p.month, d: p.day, H: p.hour, M: p.minute, S: p.second }
}
const monthOf = (ts: string) => { const b = berlin(ts); return `${b.y}-${b.m}` }
const ascii = (s: string) => s.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/"/g, "'")
const q = (s: string) => `"${s}"`
const eur = (v: number) => v.toFixed(2).replace('.', ',') // DATEV : virgule décimale

// Seuls les paiements réellement effectués (avec une transaction) sont comptabilisés
export const paidInMonth = (entries: LedgerEntry[], month: string) =>
  entries.filter(e => e.decision === 'allow' && e.txid && monthOf(e.ts) === month)

export class DatevExporter implements AccountingExporter {
  constructor(private cfg: AccountingConfig) {}

  exportMonth(entries: LedgerEntry[], month: string) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Month must look like 2026-10')
    const [y, m] = month.split('-').map(Number)
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
    const now = berlin(new Date())

    // Ligne 1 : en-tête DATEV (31 champs)
    const header = [
      q('EXTF'), 700, 21, q('Buchungsstapel'), 13,
      `${now.y}${now.m}${now.d}${now.H}${now.M}${now.S}000`, '', q('AP'), q('AgentGetPay'), q(''),
      this.cfg.consultantNumber, this.cfg.clientNumber, `${y}0101`, 4,
      `${y}${String(m).padStart(2, '0')}01`, `${y}${String(m).padStart(2, '0')}${lastDay}`,
      q(`AgentGetPay ${month}`), q(''), 1, 0, 0, q('EUR'), '', q(''), '', '',
      q(this.cfg.chartOfAccounts), '', '', q(''), q('')
    ].join(';')

    // Ligne 2 : noms des colonnes
    const columns = [
      'Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'WKZ Umsatz', 'Kurs', 'Basis-Umsatz',
      'WKZ Basis-Umsatz', 'Konto', 'Gegenkonto (ohne BU-Schlüssel)', 'BU-Schlüssel', 'Belegdatum',
      'Belegfeld 1', 'Belegfeld 2', 'Skonto', 'Buchungstext'
    ].join(';')

    // Lignes suivantes : une écriture par paiement
    const rows = paidInMonth(entries, month).map(e => {
      const b = berlin(e.ts)
      const service = new URL(e.url)
      const text = ascii(`AI ${e.agentId} ${service.host}${service.pathname}`).slice(0, 60)
      return [
        eur(e.amountEur), q('S'), q('EUR'), '', '', q(''),
        this.cfg.expenseAccount, this.cfg.walletAccount, q(''),
        `${b.d}${b.m}`,                       // Belegdatum (TTMM)
        q(`AGP-${e.seq}`),                    // Belegfeld 1 : numéro de pièce = entrée du journal
        q(e.txid!.slice(0, 12)),              // Belegfeld 2 : début de la transaction BSV
        '', q(text)
      ].join(';')
    })

    return {
      filename: `EXTF_Buchungsstapel_AgentGetPay_${month}.csv`,
      content: [header, columns, ...rows].join('\r\n') + '\r\n'
    }
  }
}

// ---- Relevé mensuel lisible (le "Beleg" pour le comptable), avec les preuves blockchain ----
export function monthlyStatementHtml(entries: LedgerEntry[], anchors: Anchor[], month: string, cfg: AccountingConfig) {
  const paid = paidInMonth(entries, month)
  const total = paid.reduce((s, e) => s + e.amountEur, 0)
  const lastSeq = paid.at(-1)?.seq ?? 0
  const seal = anchors.find(a => a.seq >= lastSeq)
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
  const date = (ts: string) => { const b = berlin(ts); return `${b.d}.${b.m}.${b.y} ${b.H}:${b.M}` }
  const byAgent = new Map<string, number>()
  for (const e of paid) byAgent.set(e.agentId, (byAgent.get(e.agentId) ?? 0) + e.amountEur)

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Statement ${esc(month)}</title>
<style>
  body { font: 13px/1.5 -apple-system, "Segoe UI", sans-serif; color: #16181d; max-width: 900px; margin: 32px auto; padding: 0 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; } .muted { color: #6b7280; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .total td { font-weight: 700; border-top: 2px solid #16181d; }
  .box { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 16px; margin-top: 16px; }
  a { color: #2f4fd8; } @media print { a { color: inherit; text-decoration: none; } }
</style></head><body>
<h1>AI agent spending statement — ${esc(month)}</h1>
<div class="muted">${esc(cfg.companyName)} · generated ${esc(date(new Date().toISOString()))} · ${paid.length} payment(s) · amounts in EUR</div>

<table>
  <thead><tr><th>Voucher</th><th>Date</th><th>Agent</th><th>Service</th><th>Purpose</th><th>Approved by</th><th class="num">Amount</th><th>BSV transaction</th></tr></thead>
  <tbody>
  ${paid.map(e => `<tr><td>AGP-${e.seq}</td><td>${esc(date(e.ts))}</td><td>${esc(e.agentId)}</td>
    <td>${esc(new URL(e.url).host + new URL(e.url).pathname)}</td><td>${esc(e.purpose)}</td>
    <td>${esc(e.approvedBy ?? 'Within policy')}</td><td class="num">€${e.amountEur.toFixed(2)}</td>
    <td><a href="https://test.whatsonchain.com/tx/${e.txid}">${e.txid!.slice(0, 12)}…</a></td></tr>`).join('')}
  <tr class="total"><td colspan="6">Total</td><td class="num">€${total.toFixed(2)}</td><td></td></tr>
  </tbody>
</table>

<table>
  <thead><tr><th>Agent</th><th class="num">Spent</th></tr></thead>
  <tbody>${[...byAgent].map(([a, v]) => `<tr><td>${esc(a)}</td><td class="num">€${v.toFixed(2)}</td></tr>`).join('')}</tbody>
</table>

<div class="box">
  <b>Audit proof.</b>
  ${seal
    ? `All payments above are recorded in a hash-chained audit log, sealed on the BSV blockchain up to entry #${seal.seq}
       (fingerprint <code>${esc(seal.hash.slice(0, 16))}…</code>, transaction
       <a href="https://test.whatsonchain.com/tx/${seal.txid}">${seal.txid.slice(0, 16)}…</a>).
       Anyone can verify that these records were not changed after that point.`
    : `The latest entries are not anchored on the blockchain yet. Anchor the log before closing the month.`}
</div>
<p class="muted">Booked as: account ${esc(cfg.expenseAccount)} against ${esc(cfg.walletAccount)} (SKR${esc(cfg.chartOfAccounts)}). Network fees are not included.</p>
</body></html>`
}
