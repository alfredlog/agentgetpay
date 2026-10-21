// Le PAYMENT PROXY : les agents passent par ici, ils n'ont jamais la clé.
// Pour chaque 402 : règles → réservation du budget → signature → paiement → journal.
import 'dotenv/config'
import express from 'express'
import { readFileSync } from 'node:fs'
import { payFetch } from '../agent/pay-fetch.js'
import { WhatsOnChainUtxoProvider, UtxoProvider, ChainedUtxoProvider } from '../shared/utxo.js'
import { JsonPolicyEngine, fmt } from './policy.js'
import { MemoryBudgetStore } from './budget.js'
import { EnvKeyStore } from './keystore.js'
import { JsonlLedger } from './ledger.js'
import { Decision, ApprovalChannel } from './types.js'
import { TelegramApprovalChannel, AutoApprovalChannel } from './approval.js'
import { AnchorLog, BsvAnchorRail, verifyAgainstChain, cachedWocFetch, FetchTxHex, Anchor } from './anchor.js'
import { Mutex } from '../shared/mutex.js'
import { DatevExporter, loadAccountingConfig, monthlyStatementHtml } from './accounting.js'
import type { Broadcaster } from '@bsv/sdk'

// Testnet : les coins n'ont pas de valeur, on fixe un taux fictif pour des montants lisibles.
// Mainnet : ce taux viendra d'une API de cours en temps réel.
const EUR_PER_SAT = Number(process.env.EUR_PER_SAT ?? 0.01)
const PORT = Number(process.env.PROXY_PORT ?? 5050)

const agents: { id: string; apiKey: string }[] = JSON.parse(readFileSync('config/agents.json', 'utf8'))
const budget = new MemoryBudgetStore()
const policy = new JsonPolicyEngine('config/policies.json', budget, EUR_PER_SAT)
const keys = new EnvKeyStore(process.env.BSV_WIF!)
const ledger = new JsonlLedger('data/ledger.jsonl')
const anchorLog = new AnchorLog('data/anchors.jsonl')
const ANCHOR_EVERY = Number(process.env.ANCHOR_EVERY ?? 5) // ancrer sur BSV toutes les N entrées du journal

// Telegram si configuré, sinon validation automatique (APPROVAL_AUTO=approved|rejected) pour les tests
const approvals: ApprovalChannel = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
  ? new TelegramApprovalChannel(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID)
  : new AutoApprovalChannel(process.env.APPROVAL_AUTO === 'approved' ? 'approved' : 'rejected')

export function createProxy(
  inner: UtxoProvider = new WhatsOnChainUtxoProvider(),
  opts: { broadcaster?: Broadcaster; fetchTxHex?: FetchTxHex } = {}
) {
  const utxos = new ChainedUtxoProvider(inner)
  const walletLock = new Mutex() // paiements et ancrages dépensent le même portefeuille, un à la fois
  const rail = new BsvAnchorRail(keys.address('company'), () => keys.unlocker('company'), utxos, walletLock, opts.broadcaster)
  const fetchTxHex = opts.fetchTxHex ?? cachedWocFetch

  // ---- Ancrage : publie le hash de la dernière entrée sur BSV ----
  const anchorLock = new Mutex()
  const anchorNow = () => anchorLock.run(async (): Promise<Anchor | undefined> => {
    const last = (await ledger.all()).at(-1)
    const prev = anchorLog.last()
    if (!last || (prev && prev.seq >= last.seq)) return prev
    const txid = await rail.publish(last.seq, last.hash)
    const a = { seq: last.seq, hash: last.hash, txid, ts: new Date().toISOString() }
    anchorLog.add(a)
    console.log(`⚓ Audit log anchored on BSV up to entry #${a.seq} — https://test.whatsonchain.com/tx/${txid}`)
    return a
  })
  let anchorInProgress = false // évite de lancer un 2e ancrage pendant qu'un ancrage est déjà en cours
  const maybeAnchor = async () => {
    if (anchorInProgress) return
    const lastSeq = (await ledger.all()).at(-1)?.seq ?? 0
    if (lastSeq - (anchorLog.last()?.seq ?? 0) >= ANCHOR_EVERY) {
      anchorInProgress = true
      anchorNow()
        .catch(e => console.error('⚠ Anchor failed:', (e as Error).message))
        .finally(() => { anchorInProgress = false })
    }
  }
  const record = async (e: Parameters<typeof ledger.record>[0]) => { await ledger.record(e); void maybeAnchor() }

  const app = express()
  app.use(express.json({ limit: '60mb' })) // assez grand pour des PDF en base64
  app.use(express.static('public')) // le tableau de bord : http://localhost:5050

  // Validations en attente, pour les afficher en direct sur le tableau de bord
  const pending = new Map<number, { agentId: string; amountEur: number; url: string; purpose?: string; since: string }>()
  let pendingSeq = 0

  // L'agent s'identifie avec sa clé d'API (jamais avec une clé de portefeuille)
  app.post('/v1/fetch', async (req, res) => {
    const agent = agents.find(a => `Bearer ${a.apiKey}` === req.get('Authorization'))
    if (!agent) return res.status(401).json({ error: 'Unknown agent' })

    const { url, method = 'GET', body, purpose } = req.body ?? {}
    if (!url) return res.status(400).json({ error: 'Missing url' })

    let decision: Decision | undefined
    let approvedBy: string | undefined
    let reserved = 0
    let amountSats = 0

    try {
      const { response, paid } = await payFetch(url, {
        method,
        body: body ? JSON.stringify(body) : undefined,
        headers: body ? { 'Content-Type': 'application/json' } : undefined
      }, {
        address: keys.address(agent.id),
        unlocker: () => keys.unlocker(agent.id),
        utxos,
        spendLock: walletLock,
        onSpent: tx => utxos.remember(tx), // la monnaie sert au prochain paiement
        beforePay: async offer => {
          amountSats = offer.amount
          const amountEur = offer.amount * EUR_PER_SAT
          const payReq = { agentId: agent.id, url, amountSats, amountEur, purpose }
          decision = await policy.evaluate(payReq)

          // Au-dessus du seuil : on demande à un humain, et l'agent attend
          if (decision.kind === 'needs_approval') {
            console.log(`⏳ ${agent.id} is waiting for approval of ${fmt(amountEur)}…`)
            const pid = ++pendingSeq
            pending.set(pid, { agentId: agent.id, amountEur, url, purpose, since: new Date().toISOString() })
            const answer = await approvals.requestApproval(payReq, decision.reason).finally(() => pending.delete(pid))
            if (answer.status !== 'approved') {
              decision = { kind: 'deny', reason: answer.status === 'timeout' ? 'No answer to the approval request' : `Rejected by ${answer.by}` }
              return false
            }
            approvedBy = answer.by
            decision = { kind: 'allow' }
          }
          if (decision.kind !== 'allow') return false
          // Réserver le budget AVANT de signer (deux paiements simultanés ne peuvent pas dépasser)
          const limitSats = Math.floor(policy.rulesFor(agent.id)!.daily_budget_eur / EUR_PER_SAT)
          if (!(await budget.tryReserve(agent.id, amountSats, limitSats))) {
            decision = { kind: 'deny', reason: 'Daily budget exceeded' }
            return false
          }
          reserved = amountSats
          return true
        }
      })

      if (paid) {
        await record({ agentId: agent.id, url, amountSats, amountEur: amountSats * EUR_PER_SAT, purpose, decision: 'allow', txid: paid.txid, approvedBy })
        console.log(`✔ ${agent.id} paid ${fmt(amountSats * EUR_PER_SAT)} (${amountSats} sats) → ${url}${approvedBy ? ` — approved by ${approvedBy}` : ''}`)
      }
      res.status(response.status).set('X-Paid-Sats', String(paid?.amount ?? 0))
        .type(response.headers.get('content-type') ?? 'text/plain').send(Buffer.from(await response.arrayBuffer()))
    } catch (err) {
      if (reserved) await budget.release(agent.id, reserved) // paiement échoué : on rend le budget
      const d = decision && decision.kind !== 'allow' ? decision : undefined
      await record({
        agentId: agent.id, url, amountSats, amountEur: amountSats * EUR_PER_SAT, purpose,
        decision: d?.kind ?? 'error', reason: d?.reason ?? (err as Error).message
      })
      console.log(`✘ ${agent.id} → ${url} : ${d?.reason ?? (err as Error).message}`)
      res.status(d ? 403 : 502).json({ decision: d?.kind ?? 'error', reason: d?.reason ?? (err as Error).message })
    }
  })

  // Pour le tableau de bord
  app.get('/v1/ledger', async (_req, res) => res.json(await ledger.all()))

  // Résumé pour le tableau de bord : budget de chaque agent + validations en attente
  app.get('/v1/stats', async (_req, res) => {
    const list = await Promise.all(agents.map(async a => {
      const r = policy.rulesFor(a.id)
      return {
        agentId: a.id,
        spentEur: (await budget.spentToday(a.id)) * EUR_PER_SAT,
        budgetEur: r?.daily_budget_eur ?? 0,
        maxPerPaymentEur: r?.max_per_payment_eur ?? 0,
        approvalAboveEur: r?.approval_above_eur ?? 0,
        allowedDomains: r?.allowed_domains ?? []
      }
    }))
    res.json({ agents: list, pending: [...pending.values()], eurPerSat: EUR_PER_SAT, anchors: anchorLog.all() })
  })
  app.get('/v1/ledger/verify', async (_req, res) => res.json(await ledger.verify()))

  // Vérifie le journal local CONTRE les ancrages publiés sur BSV
  app.get('/v1/ledger/verify-chain', async (_req, res) => {
    try { res.json(await verifyAgainstChain(await ledger.all(), anchorLog.all(), fetchTxHex)) }
    catch (e) { res.status(502).json({ error: (e as Error).message }) }
  })

  // Export comptable du mois (par défaut : le mois en cours)
  const currentMonth = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 7)
  app.get('/v1/export/datev', async (req, res) => {
    try {
      const { filename, content } = new DatevExporter(loadAccountingConfig()).exportMonth(await ledger.all(), String(req.query.month ?? currentMonth()))
      res.set('Content-Disposition', `attachment; filename="${filename}"`).set('Content-Type', 'text/csv; charset=windows-1252').send(Buffer.from(content, 'latin1'))
    } catch (e) { res.status(400).json({ error: (e as Error).message }) }
  })
  app.get('/v1/export/statement', async (req, res) => {
    const month = String(req.query.month ?? currentMonth())
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Month must look like 2026-10' })
    res.type('html').send(monthlyStatementHtml(await ledger.all(), anchorLog.all(), month, loadAccountingConfig()))
  })

  // Ancrer tout de suite (bouton du tableau de bord ou npm run anchor)
  app.post('/v1/anchor', async (_req, res) => {
    try { res.json(await anchorNow() ?? { message: 'Nothing to anchor yet' }) }
    catch (e) { res.status(502).json({ error: (e as Error).message }) }
  })

  return app
}

if (process.argv[1]?.endsWith('server.ts')) {
  createProxy().listen(PORT, () => console.log(`Payment proxy ready on http://localhost:${PORT} — dashboard: http://localhost:${PORT}`))
}
