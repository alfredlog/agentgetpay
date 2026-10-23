// Le cœur du proxy : un achat de bout en bout.
//
//   règles → (mandat ?) → (validation humaine ?) → réservation du budget → paiement → journal
//
// Validation longue : si personne n'a répondu au bout de quelques secondes, la demande est enregistrée et l'agent
// reçoit tout de suite « en attente (R-…) ». Il continue son travail. Quand un humain valide — une heure ou trois
// jours plus tard — le proxy EXÉCUTE l'achat tout seul (jamais plus cher que le montant validé), garde le résultat
// pour l'agent, et le prévient sur son adresse de rappel s'il en a donné une.
//
// Remboursements : un marchand peut renvoyer l'argent (annulation). Il joint la transaction de remboursement dans
// l'en-tête PAYMENT-REFUND ; le proxy vérifie qu'elle paie bien le portefeuille de l'entreprise, la diffuse, et
// l'enregistre dans le journal (le budget est rendu).
import { Transaction, P2PKH, WhatsOnChainBroadcaster, type Broadcaster } from '@bsv/sdk'
import { payFetch, validOrder } from '../agent/pay-fetch.js'
import type { ChainedUtxoProvider } from '../shared/utxo.js'
import type { Mutex } from '../shared/mutex.js'
import { decode, type OrderInfo } from '../shared/x402.js'
import type { JsonPolicyEngine } from './policy.js'
import { fmt } from './policy.js'
import type { MemoryBudgetStore } from './budget.js'
import { monthOf } from './budget.js'
import type { Decision, Ledger, LedgerEntry, KeyStore } from './types.js'
import type { RequestStore, StoredRequest, MandateTerms } from './requests.js'
import type { MandateStore } from './mandates.js'
import type { ApprovalNotifier } from './approval.js'

export interface PurchaseDeps {
  eurPerSat: number
  policy: JsonPolicyEngine
  budget: MemoryBudgetStore
  keys: KeyStore
  utxos: ChainedUtxoProvider
  walletLock: Mutex
  ledger: Ledger
  record: (e: Parameters<Ledger['record']>[0]) => Promise<unknown>
  requests: RequestStore
  mandates: MandateStore
  notifiers: ApprovalNotifier[]
  isActive: (agentId: string) => boolean
  checkTarget: (url: unknown, agentId: string) => string | undefined
  broadcaster?: Broadcaster
  approvalTtlHours: number
  publicBase: string // pour le lien du résultat donné à l'agent
}

export interface PurchaseInput {
  agentId: string
  url: string
  method: string
  body?: unknown
  purpose?: string
  callbackUrl?: string
  waitMs: number                 // combien de temps l'agent est prêt à attendre une validation, en direct
  preApproved?: StoredRequest    // exécution d'une demande déjà validée
}

export type PurchaseOutcome =
  | { kind: 'done'; status: number; contentType: string; body: Buffer; paidSats: number; txid?: string; refundedSats?: number; requestId?: string }
  | { kind: 'refused'; status: number; decision: string; reason: string; requestId?: string }
  | { kind: 'pending'; request: StoredRequest }

class PendingApproval extends Error { constructor(public request: StoredRequest) { super('pending approval') } }

export function createPurchaseEngine(d: PurchaseDeps) {
  const eur = (sats: number) => sats * d.eurPerSat
  const waiters = new Map<string, (r: { approved: boolean; by: string }) => void>()

  // ---- Prévenir les humains, puis mettre leurs messages à jour ----
  const notifyAll = async (r: StoredRequest) => {
    const notices: Record<string, unknown> = {}
    for (const n of d.notifiers) Object.assign(notices, (await n.notify(r).catch(() => undefined)) ?? {})
    if (Object.keys(notices).length) d.requests.update(r.id, { notices })
  }
  const closeAll = (r: StoredRequest, outcome: string) => { for (const n of d.notifiers) void n.closed(r, outcome).catch(() => {}) }

  // ---- Prévenir l'agent (adresse de rappel), sans jamais suivre de redirection ----
  const callback = (r: StoredRequest) => {
    if (!r.callbackUrl || d.checkTarget(r.callbackUrl, r.agentId)) return
    const payload = {
      requestId: r.id, kind: r.kind, status: r.status, decidedBy: r.decidedBy, reason: r.result?.error,
      paidSats: r.result?.paidSats, txid: r.result?.txid, mandateId: r.result?.mandateId,
      result: r.status === 'completed' && r.kind === 'payment' ? `${d.publicBase}/v1/requests/${r.id}/result` : undefined
    }
    void fetch(r.callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), redirect: 'manual', signal: AbortSignal.timeout(5000) })
      .catch(e => console.error(`⚠ Callback for ${r.id} failed:`, (e as Error).message))
  }

  const newRequest = async (r: Omit<StoredRequest, 'id' | 'createdAt' | 'status' | 'expiresAt'>, body?: unknown) => {
    const created = d.requests.create({ ...r, expiresAt: new Date(Date.now() + d.approvalTtlHours * 3600_000).toISOString() }, body)
    console.log(`⏳ ${created.agentId} is waiting for approval: ${created.id} — ${created.reason}`)
    await notifyAll(created)
    return d.requests.get(created.id)!
  }

  const waitDecision = (id: string, ms: number) => new Promise<{ approved: boolean; by: string } | undefined>(resolve => {
    if (ms <= 0) return resolve(undefined)
    const timer = setTimeout(() => { waiters.delete(id); resolve(undefined) }, ms)
    waiters.set(id, r => { clearTimeout(timer); waiters.delete(id); resolve(r) })
  })

  // ---- Remboursement annoncé par un marchand ----
  const handleRefund = async (header: string | null, agentId: string, url: string): Promise<number | undefined> => {
    if (!header) return undefined
    try {
      const n = decode<{ paymentTxid: string; refundTxid: string; rawtx: string }>(header)
      const tx = Transaction.fromHex(n.rawtx)
      if (tx.id('hex') !== n.refundTxid) throw new Error('refund transaction id mismatch')
      const mine = new P2PKH().lock(d.keys.address(agentId)).toHex()
      const sats = tx.outputs.filter(o => o.lockingScript.toHex() === mine).reduce((s, o) => s + (o.satoshis ?? 0), 0)
      if (!sats) throw new Error('the refund does not pay the company wallet')
      const all = await d.ledger.all()
      if (all.some(e => e.decision === 'refund' && e.txid === n.refundTxid)) return undefined // déjà enregistré
      const orig = all.find(e => e.decision === 'allow' && e.txid === n.paymentTxid)
      if (!orig || orig.agentId !== agentId) throw new Error('unknown payment')
      const already = all.filter(e => e.decision === 'refund' && e.refundOf === n.paymentTxid).reduce((s, e) => s + e.amountSats, 0)
      if (already + sats > orig.amountSats) throw new Error('refund larger than the payment')
      // On diffuse nous-mêmes : un remboursement non diffusé ne vaut rien
      const r = await tx.broadcast(d.broadcaster ?? new WhatsOnChainBroadcaster('test'))
      if (r.status !== 'success' && !/already|known|txn-already/i.test(JSON.stringify(r))) throw new Error('refund transaction rejected by the network')
      await d.record({
        agentId, url, amountSats: sats, amountEur: eur(sats), purpose: orig.purpose, decision: 'refund',
        txid: n.refundTxid, refundOf: n.paymentTxid, order: orig.order, reason: `Refund of ${fmt(orig.amountEur)} payment`
      })
      d.budget.credit(agentId, sats, orig.order?.category, orig.ts)
      console.log(`↩ ${agentId} refunded ${fmt(eur(sats))} (${sats} sats) for ${n.paymentTxid.slice(0, 12)}…`)
      return sats
    } catch (e) {
      console.error(`⚠ Refund from ${url} ignored:`, (e as Error).message)
      return undefined
    }
  }

  // Euros déjà payés ce mois-ci sous un mandat
  const usedByMandate = (entries: LedgerEntry[]) => (id: string) => {
    const month = monthOf(new Date())
    return entries.filter(e => e.mandateId === id && e.decision === 'allow' && monthOf(e.ts) === month).reduce((s, e) => s + e.amountEur, 0)
  }

  // ---- Un achat ----
  async function attempt(a: PurchaseInput): Promise<PurchaseOutcome> {
    let decision: Decision | undefined
    let approvedBy: string | undefined
    let mandateId: string | undefined
    let requestId = a.preApproved?.id
    let reserved = 0
    let amountSats = 0
    let order: OrderInfo | undefined

    try {
      const { response, paid } = await payFetch(a.url, {
        method: a.method,
        body: a.body !== undefined ? JSON.stringify(a.body) : undefined,
        headers: a.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        redirect: 'manual' // ne jamais suivre une redirection : elle pourrait mener hors des domaines autorisés
      }, {
        address: d.keys.address(a.agentId),
        unlocker: () => d.keys.unlocker(a.agentId),
        utxos: d.utxos,
        spendLock: d.walletLock,
        onSpent: tx => d.utxos.remember(tx), // la monnaie sert au prochain paiement
        beforePay: async offer => {
          amountSats = offer.amount
          order = offer.order
          const amountEur = eur(amountSats)
          decision = await d.policy.evaluate({ agentId: a.agentId, url: a.url, amountSats, amountEur, purpose: a.purpose, order })

          if (decision.kind === 'needs_approval') {
            const pre = a.preApproved
            const m = pre ? undefined : d.mandates.covering(a.agentId, new URL(a.url).hostname, order?.category, amountEur, usedByMandate(await d.ledger.all()))
            if (pre) {
              // Demande déjà validée : jamais plus cher que ce qui a été validé
              if (amountSats > (pre.amountSats ?? 0)) {
                decision = { kind: 'deny', reason: `Price increased since approval (${fmt(amountEur)} > ${fmt(pre.amountEur ?? 0)})` }
                return false
              }
              approvedBy = pre.decidedBy
            } else if (m) {
              // Achat couvert par un mandat : pas besoin de redemander
              mandateId = m.id
              approvedBy = `mandate ${m.id} (${m.approvedBy})`
            } else {
              const r = await newRequest({
                kind: 'payment', agentId: a.agentId, url: a.url, method: a.method, amountSats, amountEur, order,
                purpose: a.purpose, reason: decision.reason, callbackUrl: a.callbackUrl
              }, a.body)
              requestId = r.id
              const answer = await waitDecision(r.id, a.waitMs)
              if (!answer) throw new PendingApproval(r) // personne n'a encore répondu : l'agent continue son travail
              if (!answer.approved) { decision = { kind: 'deny', reason: `Rejected by ${answer.by}` }; return false }
              approvedBy = answer.by
            }
            decision = { kind: 'allow' }
          }
          if (decision.kind !== 'allow') return false
          if (!d.isActive(a.agentId)) { decision = { kind: 'deny', reason: 'Agent suspended by an administrator' }; return false }
          // Réserver le budget AVANT de signer (deux paiements simultanés ne peuvent pas dépasser)
          const over = await d.budget.tryReserve(a.agentId, amountSats, d.policy.limitsFor(a.agentId, order?.category))
          if (over) { decision = { kind: 'deny', reason: over }; return false }
          reserved = amountSats
          return true
        }
      })

      if (paid) {
        await d.record({ agentId: a.agentId, url: a.url, amountSats, amountEur: eur(amountSats), purpose: a.purpose, decision: 'allow', txid: paid.txid, approvedBy, order, requestId, mandateId })
        console.log(`✔ ${a.agentId} paid ${fmt(eur(amountSats))} (${amountSats} sats) → ${a.url}${approvedBy ? ` — approved by ${approvedBy}` : ''}`)
      }
      const refundedSats = await handleRefund(response.headers.get('PAYMENT-REFUND'), a.agentId, a.url)
      return {
        kind: 'done', status: response.status, contentType: response.headers.get('content-type') ?? 'text/plain',
        body: Buffer.from(await response.arrayBuffer()), paidSats: paid?.amount ?? 0, txid: paid?.txid, refundedSats, requestId
      }
    } catch (err) {
      if (err instanceof PendingApproval) return { kind: 'pending', request: err.request }
      if (reserved) await d.budget.release(a.agentId, reserved, order?.category) // paiement échoué : on rend le budget
      const dec = decision && decision.kind !== 'allow' ? decision : undefined
      // "fetch failed" = le service n'a pas répondu du tout (par exemple : le vendeur n'est pas lancé)
      if ((err as Error).message === 'fetch failed') (err as Error).message = `Service unreachable: ${new URL(a.url).host}`
      const reason = dec?.reason ?? (err as Error).message
      await d.record({ agentId: a.agentId, url: a.url, amountSats, amountEur: eur(amountSats), purpose: a.purpose, order, requestId, decision: dec?.kind ?? 'error', reason })
      console.log(`✘ ${a.agentId} → ${a.url} : ${reason}`)
      return { kind: 'refused', status: dec ? 403 : 502, decision: dec?.kind ?? 'error', reason, requestId }
    }
  }

  // Termine une demande (statut, résultat, messages, rappel)
  const finish = (r: StoredRequest, patch: Partial<StoredRequest>, outcome: string) => {
    const done = d.requests.update(r.id, patch)!
    d.requests.dropBody(r.id)
    closeAll(done, outcome)
    callback(done)
    return done
  }

  // ---- Exécution d'une demande validée (en arrière-plan) ----
  async function execute(r: StoredRequest) {
    if (r.kind === 'mandate' && r.mandate) {
      const m = d.mandates.create({ ...r.mandate, agentId: r.agentId, purpose: r.purpose, approvedBy: r.decidedBy ?? 'unknown', requestId: r.id })
      await d.record({ agentId: r.agentId, url: `mandate://${m.domain}`, amountSats: 0, amountEur: 0, decision: 'admin', approvedBy: r.decidedBy, requestId: r.id, mandateId: m.id, reason: `Mandate ${m.id} granted: ${m.domain}${m.category ? ` (${m.category})` : ''}, up to ${fmt(m.maxEurPerMonth)}/month for ${m.months} month(s)` })
      finish(r, { status: 'completed', result: { status: 200, contentType: 'application/json', mandateId: m.id } }, `✅ Approved by ${r.decidedBy} · mandate ${m.id} active`)
      return
    }
    const out = await attempt({ agentId: r.agentId, url: r.url!, method: r.method ?? 'GET', body: d.requests.body(r.id), purpose: r.purpose, waitMs: 0, preApproved: r })
    if (out.kind === 'done') {
      d.requests.saveResult(r.id, out.body)
      const ok = out.status < 400
      finish(r, { status: ok ? 'completed' : 'failed', result: { status: out.status, contentType: out.contentType, paidSats: out.paidSats, txid: out.txid, ...(ok ? {} : { error: `Service answered ${out.status}` }) } },
        ok ? `✅ Approved by ${r.decidedBy} · paid ${fmt(eur(out.paidSats))}` : `⚠ Approved by ${r.decidedBy}, but the service answered ${out.status}`)
    } else if (out.kind === 'refused') {
      finish(r, { status: 'failed', result: { status: out.status, contentType: 'application/json', error: out.reason } }, `⚠ Approved by ${r.decidedBy}, but not paid: ${out.reason}`)
    }
  }

  // ---- Une décision humaine (Telegram, tableau de bord…) ----
  async function decide(id: string, approved: boolean, by: string): Promise<string> {
    const r = d.requests.get(id)
    if (!r) return 'Unknown request'
    if (r.status !== 'pending') return `Already ${r.status}`
    const updated = d.requests.update(id, { status: approved ? 'approved' : 'rejected', decidedBy: by, decidedAt: new Date().toISOString() })!
    console.log(`${approved ? '✅' : '❌'} ${by} ${approved ? 'approved' : 'rejected'} ${id}`)
    const waiter = waiters.get(id)
    if (waiter) {
      // L'agent attend encore en direct : c'est lui qui termine l'achat
      waiter({ approved, by })
      return approved ? 'Approved' : 'Rejected'
    }
    if (!approved) {
      if (r.kind === 'payment') await d.record({ agentId: r.agentId, url: r.url!, amountSats: r.amountSats ?? 0, amountEur: r.amountEur ?? 0, purpose: r.purpose, order: r.order, requestId: id, decision: 'deny', reason: `Rejected by ${by}` })
      finish(updated, {}, `❌ Rejected by ${by}`)
      return 'Rejected'
    }
    void execute(updated).catch(e => {
      console.error(`⚠ Execution of ${id} failed:`, (e as Error).message)
      finish(updated, { status: 'failed', result: { status: 500, contentType: 'application/json', error: (e as Error).message } }, `⚠ Approved by ${by}, but failed: ${(e as Error).message}`)
    })
    return 'Approved: executing now'
  }

  // Une demande terminée en direct (l'agent attendait) : on la clôt aussi
  function settleInline(out: PurchaseOutcome) {
    const id = out.kind === 'done' || out.kind === 'refused' ? out.requestId : undefined
    const r = id ? d.requests.get(id) : undefined
    if (!r || (r.status !== 'approved' && r.status !== 'rejected')) return
    if (out.kind === 'done') finish(r, { status: out.status < 400 ? 'completed' : 'failed', result: { status: out.status, contentType: out.contentType, paidSats: out.paidSats, txid: out.txid } }, r.status === 'approved' ? `✅ Approved by ${r.decidedBy} · paid ${fmt(eur(out.paidSats))}` : `❌ Rejected by ${r.decidedBy}`)
    else if (out.kind === 'refused') finish(r, r.status === 'rejected' ? {} : { status: 'failed', result: { status: out.status, contentType: 'application/json', error: out.reason } }, r.status === 'rejected' ? `❌ Rejected by ${r.decidedBy}` : `⚠ Approved, but not paid: ${out.reason}`)
  }

  // ---- Demande de mandat (achats récurrents) ----
  async function requestMandate(agentId: string, terms: MandateTerms, purpose: string | undefined, callbackUrl: string | undefined, waitMs: number) {
    const r = await newRequest({ kind: 'mandate', agentId, mandate: terms, purpose, callbackUrl, reason: 'Standing approvals always need a human' })
    const answer = await waitDecision(r.id, waitMs)
    if (answer) {
      // Décidé en direct : execute() a besoin du statut à jour
      if (answer.approved) await execute(d.requests.get(r.id)!)
      else finish(d.requests.get(r.id)!, {}, `❌ Rejected by ${answer.by}`)
    }
    return d.requests.get(r.id)!
  }

  // ---- Demandes sans réponse : expirées ----
  async function sweep() {
    const now = new Date().toISOString()
    for (const r of d.requests.open()) {
      if (r.expiresAt > now || waiters.has(r.id)) continue
      if (r.kind === 'payment') await d.record({ agentId: r.agentId, url: r.url!, amountSats: r.amountSats ?? 0, amountEur: r.amountEur ?? 0, purpose: r.purpose, order: r.order, requestId: r.id, decision: 'deny', reason: 'No answer to the approval request' })
      finish(r, { status: 'expired' }, '⌛ No answer in time: request expired')
      console.log(`⌛ ${r.id} expired`)
    }
  }

  // ---- Au démarrage : reprendre ce qui a été validé mais pas encore exécuté (arrêt brutal) ----
  async function resume() {
    const entries = await d.ledger.all()
    for (const r of d.requests.list(x => x.status === 'approved')) {
      const paid = entries.find(e => e.requestId === r.id && e.decision === 'allow')
      if (paid) finish(r, { status: 'completed', result: { status: 200, contentType: 'application/json', paidSats: paid.amountSats, txid: paid.txid } }, `✅ Approved by ${r.decidedBy} · paid`)
      else void execute(r).catch(e => console.error(`⚠ Resume of ${r.id} failed:`, (e as Error).message))
    }
  }

  for (const n of d.notifiers) n.onDecision(decide)

  // Lit l'offre d'un service sans payer (pour un devis)
  const quoteOrder = (header: string | null) => {
    if (!header) return undefined
    const offer = decode<{ accepts?: { amount: string }[]; resource?: { description?: string }; extensions?: { order?: unknown } }>(header)
    return { sats: Number(offer.accepts?.[0]?.amount), description: offer.resource?.description, order: validOrder(offer.extensions?.order) }
  }

  return { attempt, decide, execute, settleInline, requestMandate, sweep, resume, quoteOrder, usedByMandate }
}
