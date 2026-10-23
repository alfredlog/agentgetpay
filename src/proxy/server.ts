// Le PAYMENT PROXY : les agents passent par ici, ils n'ont jamais la clé.
// Pour chaque 402 : règles → réservation du budget → signature → paiement → journal.
import 'dotenv/config'
import express from 'express'
import { appendFileSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WhatsOnChainUtxoProvider, UtxoProvider, ChainedUtxoProvider } from '../shared/utxo.js'
import { JsonPolicyEngine, fmt, formatAddress } from './policy.js'
import { MemoryBudgetStore } from './budget.js'
import { EnvKeyStore } from './keystore.js'
import { JsonlLedger } from './ledger.js'
import { TelegramNotifier, AutoNotifier, DashboardOnlyNotifier, type ApprovalNotifier } from './approval.js'
import { RequestStore, type StoredRequest } from './requests.js'
import { MandateStore } from './mandates.js'
import { createPurchaseEngine } from './purchase.js'
import { AnchorLog, BsvAnchorRail, verifyAgainstChain, cachedWocFetch, FetchTxHex, Anchor } from './anchor.js'
import { Mutex } from '../shared/mutex.js'
import { DatevExporter, loadAccountingConfig, monthlyStatementHtml } from './accounting.js'
import { AgentRegistry, validateRules, validAgentId } from './registry.js'
import { ViewerStore, validViewerName } from './viewers.js'
import { OAuthServer } from './oauth.js'
import type { Broadcaster } from '@bsv/sdk'


// Testnet : les coins n'ont pas de valeur, on fixe un taux fictif pour des montants lisibles.
// Mainnet : ce taux viendra d'une API de cours en temps réel.
const EUR_PER_SAT = Number(process.env.EUR_PER_SAT ?? 0.01)
const PORT = Number(process.env.PROXY_PORT ?? 5050)
// Par défaut, le proxy n'écoute que sur cet ordinateur (127.0.0.1) : personne d'autre sur le réseau ne le voit.
// PROXY_HOST=0.0.0.0 l'ouvre au réseau ; il faut alors le mot de passe admin partout, et les clés de démo sont refusées.
const HOST = process.env.PROXY_HOST ?? '127.0.0.1'
const truthy = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase())
// Derrière un serveur web (Caddy, nginx), le proxy écoute sur 127.0.0.1 mais il est PUBLIC : PROXY_PUBLIC=true le dit.
const EXPOSED = !['127.0.0.1', 'localhost', '::1'].includes(HOST) || truthy(process.env.PROXY_PUBLIC)
// Adresse publique du proxy (ex. agentpay.pdf-libre.de) : un agent ne doit jamais pouvoir l'appeler
const PUBLIC_HOST = (process.env.PROXY_PUBLIC_HOST ?? '').trim().toLowerCase()
// Démo publique : le tableau de bord se consulte sans mot de passe (exports, ancrage et administration restent protégés)
const PUBLIC_READ = truthy(process.env.DASHBOARD_PUBLIC_READ)
// Connexion OAuth des assistants IA : adresse publique de ce serveur et du serveur MCP
const ISSUER = (process.env.OAUTH_ISSUER ?? (PUBLIC_HOST ? `https://${PUBLIC_HOST}` : `http://127.0.0.1:${PORT}`)).replace(/\/$/, '')
const MCP_URL = (process.env.MCP_PUBLIC_URL ?? (PUBLIC_HOST ? `${ISSUER}/mcp` : `http://127.0.0.1:${process.env.MCP_PORT ?? 5070}/mcp`)).replace(/\/$/, '')

const registry = new AgentRegistry()
const viewers = new ViewerStore() // personnes autorisées à consulter le tableau de bord
const budget = new MemoryBudgetStore()
const policy = new JsonPolicyEngine(registry, budget, EUR_PER_SAT)

// Mot de passe de la page d'administration : créé automatiquement au premier démarrage
let ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? ''
if (ADMIN_TOKEN.length < 12) {
  ADMIN_TOKEN = randomBytes(18).toString('base64url')
  appendFileSync('.env', `\nADMIN_TOKEN=${ADMIN_TOKEN}\n`)
  console.log(`Admin password created and saved in .env: ${ADMIN_TOKEN}`)
}
const keys = new EnvKeyStore(process.env.BSV_WIF!)
const ledger = new JsonlLedger('data/ledger.jsonl')
budget.restoreFrom(ledger.allSync()) // les dépenses du jour survivent à un redémarrage
const anchorLog = new AnchorLog('data/anchors.jsonl')
const ANCHOR_EVERY = Number(process.env.ANCHOR_EVERY ?? 5) // ancrer sur BSV toutes les N entrées du journal

// Validation humaine : Telegram si configuré ; on peut TOUJOURS aussi décider sur le tableau de bord.
// APPROVAL_AUTO=approved|rejected : réponse automatique (tests). Une demande reste ouverte APPROVAL_TTL_HOURS heures.
const notifier: ApprovalNotifier = process.env.APPROVAL_AUTO
  ? new AutoNotifier(process.env.APPROVAL_AUTO === 'approved' ? 'approved' : 'rejected', Number(process.env.APPROVAL_AUTO_DELAY_MS ?? 0))
  : process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
    ? new TelegramNotifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID)
    : new DashboardOnlyNotifier()
const APPROVAL_TTL_HOURS = Number(process.env.APPROVAL_TTL_HOURS ?? 72)
const requests = new RequestStore()
const mandates = new MandateStore()

// Mot de passe administrateur (comparaison en temps constant)
const isAdmin = (req: express.Request) => {
  const given = Buffer.from(String(req.get('X-Admin-Token') ?? ''))
  const expected = Buffer.from(ADMIN_TOKEN)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
const isAdminPassword = (password: string) => {
  const given = Buffer.from(password), expected = Buffer.from(ADMIN_TOKEN)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Wrong admin password' })
  next()
}
// Lecture du tableau de bord : l'administrateur, ou une personne qui a reçu un code d'accès (agv_…)
function requireReader(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (isAdmin(req) || viewers.authenticate(String(req.get('X-Admin-Token') ?? ''))) return next()
  res.status(401).json({ error: 'Access code required' })
}

// Vérifie l'adresse demandée par un agent. Renvoie la raison du refus, ou undefined si c'est autorisé.
function checkTarget(url: unknown, allowed: string[] | undefined): string | undefined {
  let u: URL
  try { u = new URL(String(url)) } catch { return 'Invalid URL' }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `Protocol not allowed: ${u.protocol}`
  if (!allowed) return 'No rules for this agent'
  if (!allowed.includes(u.hostname)) return `Domain not allowed: ${u.hostname}`
  // Le proxy lui-même (son journal, son administration) n'est jamais une cible pour un agent
  const self = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(u.hostname) && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === PORT
  if (self || (PUBLIC_HOST && u.hostname === PUBLIC_HOST)) return 'The payment proxy itself cannot be called by an agent'
  return undefined
}

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
  app.set('trust proxy', 'loopback') // derrière Caddy : la vraie adresse IP du visiteur (limite d'essais de connexion)
  app.use(express.json({ limit: '60mb' })) // assez grand pour des PDF en base64

  // Connexion OAuth des assistants IA (Claude, ChatGPT…) au serveur MCP distant
  const oauth = new OAuthServer({
    issuer: ISSUER, resource: MCP_URL,
    agentExists: id => !!registry.get(id),
    agentActive: id => registry.isActive(id),
    checkAdminPassword: isAdminPassword,
    onConnect: async g => {
      await record({ agentId: g.agentId, url: `admin://agents/${g.agentId}`, amountSats: 0, amountEur: 0, decision: 'admin', reason: `Assistant connected: ${g.clientName}`, approvedBy: g.by })
      console.log(`🔗 ${g.clientName} connected as ${g.agentId} (code from ${g.by})`)
    }
  })
  app.use(oauth.router())
  app.use(express.static('public')) // le tableau de bord : http://localhost:5050

  // Le moteur d'achat : règles, mandats, validations (même longues), paiement, remboursements
  const engine = createPurchaseEngine({
    eurPerSat: EUR_PER_SAT, policy, budget, keys, utxos, walletLock, ledger, record, requests, mandates,
    notifiers: [notifier],
    isActive: id => registry.isActive(id),
    checkTarget: (url, agentId) => checkTarget(url, registry.rulesFor(agentId)?.allowed_domains),
    broadcaster: opts.broadcaster,
    approvalTtlHours: APPROVAL_TTL_HOURS,
    publicBase: ISSUER
  })
  void engine.resume()
  const sweeper = setInterval(() => void engine.sweep(), Number(process.env.APPROVAL_SWEEP_MS ?? 30_000))
  sweeper.unref()

  // Une demande, vue par l'agent ou le tableau de bord
  const requestView = (r: StoredRequest) => ({
    id: r.id, kind: r.kind, agentId: r.agentId, status: r.status, reason: r.reason, purpose: r.purpose,
    createdAt: r.createdAt, expiresAt: r.expiresAt, decidedBy: r.decidedBy, decidedAt: r.decidedAt,
    url: r.url, amountEur: r.amountEur, amountSats: r.amountSats, order: r.order, mandate: r.mandate,
    result: r.result ? { status: r.result.status, paidSats: r.result.paidSats, txid: r.result.txid, mandateId: r.result.mandateId, error: r.result.error } : undefined
  })

  // L'agent s'identifie avec sa clé d'API (jamais avec une clé de portefeuille)
  const authAgent = (req: express.Request, res: express.Response) => {
    // Assistant connecté par OAuth : son jeton est lié à un agent
    const viaOAuth = oauth.authenticate(req.get('Authorization'))
    if (viaOAuth) {
      const a = registry.get(viaOAuth)
      if (!a) { res.status(401).json({ error: 'Unknown agent' }); return undefined }
      return a
    }
    const agent = registry.authenticate(req.get('Authorization'))
    if (!agent) { res.status(401).json({ error: 'Unknown agent' }); return undefined }
    // Les clés de démo (dev-…) sont publiques dans le dépôt : interdites dès que le proxy est ouvert au réseau
    if (EXPOSED && agent.apiKey && !agent.keyHash) {
      res.status(401).json({ error: 'Demo API keys are disabled when the proxy is open to the network. Issue a new key on the admin page.' })
      return undefined
    }
    return agent
  }

  // L'agent consulte SES règles, son budget restant et ses dernières opérations (rien sur les autres agents)
  app.get('/v1/me', async (req, res) => {
    const agent = authAgent(req, res)
    if (!agent) return
    const rules = registry.rulesFor(agent.id)
    const spentEur = (await budget.spentToday(agent.id)) * EUR_PER_SAT
    const spentMonthEur = (await budget.spentThisMonth(agent.id)) * EUR_PER_SAT
    const round = (v: number) => Math.max(0, Math.round(v * 100) / 100)
    const recent = (await ledger.all()).filter(e => e.agentId === agent.id && e.decision !== 'admin').slice(-10).reverse()
      .map(e => ({ time: e.ts, url: e.url, amountEur: e.amountEur, decision: e.decision, reason: e.reason, approvedBy: e.approvedBy, txid: e.txid, merchant: e.order?.merchant, category: e.order?.category }))
    // Ce qui reste vraiment : le plus petit des restes du jour et du mois
    const dayLeft = rules ? rules.daily_budget_eur - spentEur : 0
    const monthLeft = rules?.monthly_budget_eur !== undefined ? rules.monthly_budget_eur - spentMonthEur : Infinity
    const categories = rules?.categories ? Object.fromEntries(await Promise.all(Object.entries(rules.categories).map(async ([k, c]) =>
      [k, { ...c, spentMonthEur: (await budget.spentThisMonth(agent.id, k)) * EUR_PER_SAT }]))) : undefined
    res.json({
      agentId: agent.id, active: registry.isActive(agent.id), rules, spentEur, spentMonthEur,
      remainingEur: round(Math.min(dayLeft, monthLeft)),
      remainingMonthEur: Number.isFinite(monthLeft) ? round(monthLeft) : undefined,
      categories,
      mandates: mandates.active(agent.id).map(m => ({ id: m.id, domain: m.domain, category: m.category, maxEurPerMonth: m.maxEurPerMonth, validUntil: m.validUntil, usedThisMonthEur: engine.usedByMandate(ledger.allSync())(m.id) })),
      pendingRequests: requests.list(r => r.agentId === agent.id && r.status === 'pending').map(r => r.id),
      recent
    })
  })

  app.post('/v1/fetch', async (req, res) => {
    const agent = authAgent(req, res)
    if (!agent) return

    const { url, method = 'GET', body, purpose, dryRun, callbackUrl } = req.body ?? {}
    if (!url) return res.status(400).json({ error: 'Missing url' })
    // Combien de temps l'agent attend une validation en direct (0 à 120 s). Au-delà, la demande reste ouverte.
    const waitSeconds = Math.min(120, Math.max(0, Number(req.body?.waitSeconds ?? 120) || 0))

    // Contrôles AVANT tout appel réseau, que le service soit payant ou gratuit
    const refuse = async (reason: string) => {
      await record({ agentId: agent.id, url: String(url).slice(0, 300), amountSats: 0, amountEur: 0, purpose, decision: 'deny', reason })
      console.log(`✘ ${agent.id} → ${url} : ${reason}`)
      return res.status(403).json({ decision: 'deny', reason })
    }
    if (!registry.isActive(agent.id)) return refuse('Agent suspended by an administrator')
    const target = checkTarget(url, registry.rulesFor(agent.id)?.allowed_domains)
    if (target) return refuse(target)
    if (callbackUrl !== undefined && checkTarget(callbackUrl, registry.rulesFor(agent.id)?.allowed_domains)) {
      return res.status(400).json({ error: 'callbackUrl must be on one of your allowed domains' })
    }

    // Devis : demande le prix sans payer (la requête est envoyée sans contenu, rien n'est enregistré)
    if (dryRun) {
      try {
        const r = await fetch(url, { method, redirect: 'manual' })
        if (r.status !== 402) return res.json({ paymentRequired: false, status: r.status })
        const q = engine.quoteOrder(r.headers.get('PAYMENT-REQUIRED'))
        if (!q || !Number.isFinite(q.sats)) return res.status(502).json({ error: 'The service returned an unreadable price' })
        const amountEur = q.sats * EUR_PER_SAT
        const d = await policy.evaluate({ agentId: agent.id, url, amountSats: q.sats, amountEur, purpose, order: q.order })
        return res.json({
          paymentRequired: true, priceSats: q.sats, priceEur: amountEur, description: q.description, order: q.order,
          decision: d.kind, reason: d.kind === 'allow' ? undefined : d.reason
        })
      } catch (e) {
        return res.status(502).json({ error: (e as Error).message === 'fetch failed' ? `Service unreachable: ${new URL(url).host}` : (e as Error).message })
      }
    }

    const out = await engine.attempt({ agentId: agent.id, url, method, body, purpose, callbackUrl, waitMs: waitSeconds * 1000 })
    engine.settleInline(out)
    if (out.kind === 'pending') {
      const r = out.request
      return res.status(202).json({
        decision: 'pending_approval', requestId: r.id, reason: r.reason, expiresAt: r.expiresAt,
        message: `A human must approve this purchase (${r.reason}). Request ${r.id} stays open until ${r.expiresAt}. ` +
          'Continue with other work; check GET /v1/requests/' + r.id + ' later. When it is approved, the purchase is made automatically and the result is kept for you.'
      })
    }
    if (out.kind === 'refused') return res.status(out.status).json({ decision: out.decision, reason: out.reason, requestId: out.requestId })
    res.status(out.status).set('X-Paid-Sats', String(out.paidSats))
    if (out.refundedSats) res.set('X-Refunded-Sats', String(out.refundedSats))
    if (out.requestId) res.set('X-Request-Id', out.requestId)
    res.type(out.contentType).send(out.body)
  })

  // ---- Demandes de l'agent (validations longues) ----
  app.get('/v1/requests', (req, res) => {
    const agent = authAgent(req, res)
    if (!agent) return
    res.json(requests.list(r => r.agentId === agent.id).slice(-50).reverse().map(requestView))
  })
  app.get('/v1/requests/:id', (req, res) => {
    const agent = authAgent(req, res)
    if (!agent) return
    const r = requests.get(req.params.id)
    if (!r || r.agentId !== agent.id) return res.status(404).json({ error: 'Unknown request' })
    res.json(requestView(r))
  })
  // Le résultat de l'achat exécuté après validation (même format que la réponse du service)
  app.get('/v1/requests/:id/result', (req, res) => {
    const agent = authAgent(req, res)
    if (!agent) return
    const r = requests.get(req.params.id)
    if (!r || r.agentId !== agent.id) return res.status(404).json({ error: 'Unknown request' })
    const body = requests.result(r.id)
    if (!r.result || !body) return res.status(409).json({ error: `No result yet: the request is ${r.status}` })
    res.status(r.result.status).set('X-Paid-Sats', String(r.result.paidSats ?? 0)).type(r.result.contentType).send(body)
  })

  // ---- Mandats : validation unique pour des achats qui reviennent ----
  app.post('/v1/mandates', async (req, res) => {
    const agent = authAgent(req, res)
    if (!agent) return
    const b = req.body ?? {}
    const rules = registry.rulesFor(agent.id)
    const domain = String(b.domain ?? '').trim().toLowerCase()
    const max = Number(b.maxEurPerMonth), months = Number(b.months ?? 12)
    if (!rules?.allowed_domains.includes(domain)) return res.status(400).json({ error: `domain must be one of your allowed domains: ${rules?.allowed_domains.join(', ')}` })
    if (!Number.isFinite(max) || max <= 0) return res.status(400).json({ error: 'maxEurPerMonth must be a positive number' })
    if (rules.monthly_budget_eur !== undefined && max > rules.monthly_budget_eur) return res.status(400).json({ error: `maxEurPerMonth cannot exceed your monthly budget (${fmt(rules.monthly_budget_eur)})` })
    if (!Number.isInteger(months) || months < 1 || months > 24) return res.status(400).json({ error: 'months must be between 1 and 24' })
    const category = b.category ? String(b.category).trim().toLowerCase() : undefined
    if (category && !/^[a-z0-9]+(\.[a-z0-9]+)*$/.test(category)) return res.status(400).json({ error: 'Invalid category' })
    if (b.callbackUrl !== undefined && checkTarget(b.callbackUrl, rules.allowed_domains)) return res.status(400).json({ error: 'callbackUrl must be on one of your allowed domains' })
    const waitSeconds = Math.min(120, Math.max(0, Number(b.waitSeconds ?? 0) || 0))
    const r = await engine.requestMandate(agent.id, { domain, category, maxEurPerMonth: Math.round(max * 100) / 100, months }, b.purpose ? String(b.purpose).slice(0, 200) : undefined, b.callbackUrl, waitSeconds * 1000)
    res.status(r.status === 'pending' ? 202 : 200).json(requestView(r))
  })
  app.get('/v1/mandates', (req, res) => {
    const agent = authAgent(req, res)
    if (!agent) return
    const used = engine.usedByMandate(ledger.allSync())
    res.json(mandates.active(agent.id).map(m => ({ ...m, usedThisMonthEur: used(m.id) })))
  })

  // Données du tableau de bord : protégées par le mot de passe admin si le proxy est ouvert au réseau
  // Par défaut : seuls l'administrateur et les personnes qu'il a autorisées voient le tableau de bord et les exports.
  // L'ancrage (qui dépense des satoshis) reste réservé à l'administrateur.
  if (EXPOSED) {
    app.use(PUBLIC_READ ? ['/v1/export'] : ['/v1/ledger', '/v1/stats', '/v1/export'], requireReader)
    app.use('/v1/anchor', requireAdmin)
  }

  // Qui est connecté ? (le tableau de bord affiche le nom et cache les boutons réservés à l'admin)
  app.get('/v1/session', (req, res) => {
    const token = String(req.get('X-Admin-Token') ?? '')
    if (isAdmin(req)) return res.json({ role: 'admin' })
    const v = token ? viewers.authenticate(token) : undefined
    if (v) return res.json({ role: 'viewer', name: v.name })
    res.json({ role: !EXPOSED ? 'local' : PUBLIC_READ ? 'public' : 'none' })
  })

  // Pour le tableau de bord
  app.get('/v1/ledger', async (_req, res) => res.json(await ledger.all()))

  // Résumé pour le tableau de bord : budget de chaque agent + validations en attente
  app.get('/v1/stats', async (_req, res) => {
    const list = await Promise.all(registry.list().map(async a => {
      const r = policy.rulesFor(a.id)
      return {
        agentId: a.id,
        active: a.active,
        spentEur: (await budget.spentToday(a.id)) * EUR_PER_SAT,
        budgetEur: r?.daily_budget_eur ?? 0,
        spentMonthEur: (await budget.spentThisMonth(a.id)) * EUR_PER_SAT,
        monthlyBudgetEur: r?.monthly_budget_eur,
        categories: r?.categories ? Object.keys(r.categories) : [],
        maxPerPaymentEur: r?.max_per_payment_eur ?? 0,
        approvalAboveEur: r?.approval_above_eur ?? 0,
        allowedDomains: r?.allowed_domains ?? []
      }
    }))
    res.json({ agents: list, pending: requests.open().map(requestView), eurPerSat: EUR_PER_SAT, anchors: anchorLog.all() })
  })
  app.get('/v1/ledger/verify', async (_req, res) => res.json(await ledger.verify()))

  // Vérifie le journal local CONTRE les ancrages publiés sur BSV
  app.get('/v1/ledger/verify-chain', async (_req, res) => {
    try { res.json(await verifyAgainstChain(await ledger.all(), anchorLog.all(), fetchTxHex)) }
    catch (e) { res.status(502).json({ error: (e as Error).message }) }
  })

  // ---- Administration : protégée par le mot de passe ADMIN_TOKEN ----
  const admin = express.Router()
  admin.use(requireAdmin)
  // Qui a fait la modification : nom saisi sur la page d'administration (pour le journal d'audit)
  const who = (req: express.Request) => String(req.get('X-Admin-Name') ?? '').trim().slice(0, 40) || 'admin'
  const logChange = (req: express.Request, agentId: string, change: string, action?: string) =>
    record({ agentId, url: `admin://agents/${agentId}`, amountSats: 0, amountEur: 0, decision: 'admin', reason: change, approvedBy: who(req), action })
  const describe = (before: ReturnType<typeof registry.rulesFor>, after: NonNullable<ReturnType<typeof registry.rulesFor>>) => {
    if (!before) return 'Rules created'
    const parts: string[] = []
    const money = (label: string, a: number, b: number) => { if (a !== b) parts.push(`${label} ${fmt(a)} → ${fmt(b)}`) }
    money('Daily budget', before.daily_budget_eur, after.daily_budget_eur)
    money('Max per payment', before.max_per_payment_eur, after.max_per_payment_eur)
    money('Approval above', before.approval_above_eur, after.approval_above_eur)
    if (before.monthly_budget_eur !== after.monthly_budget_eur) {
      parts.push(after.monthly_budget_eur === undefined ? 'Monthly budget removed' : `Monthly budget ${before.monthly_budget_eur === undefined ? 'none' : fmt(before.monthly_budget_eur)} → ${fmt(after.monthly_budget_eur)}`)
    }
    if (before.allowed_domains.join(',') !== after.allowed_domains.join(',')) parts.push(`Domains: ${after.allowed_domains.join(', ')}`)
    const catText = (r: typeof before) => JSON.stringify(r.categories ?? null)
    if (catText(before) !== catText(after)) {
      const c = after.categories
      parts.push(c ? `Purchase categories: ${Object.entries(c).map(([k, v]) => [k,
        v.max_unit_price_eur !== undefined ? `max ${fmt(v.max_unit_price_eur)}/unit` : '',
        v.monthly_budget_eur !== undefined ? `${fmt(v.monthly_budget_eur)}/month` : '',
        v.approval_above_eur !== undefined ? `approval above ${fmt(v.approval_above_eur)}` : ''].filter(Boolean).join(' ')).join('; ')}` : 'Purchase categories removed (all categories allowed)')
    }
    const addrText = (r: typeof before) => JSON.stringify(r.shipping_addresses ?? [])
    if (addrText(before) !== addrText(after)) parts.push(`Delivery addresses: ${(after.shipping_addresses ?? []).map(formatAddress).join(' | ') || 'none'}`)
    return parts.join(' · ')
  }

  admin.get('/agents', async (_req, res) => {
    res.json(await Promise.all(registry.list().map(async a => ({
      id: a.id, active: a.active, keyHint: a.keyHint ?? (a.apiKey ? a.apiKey.slice(-4) : undefined),
      rules: registry.rulesFor(a.id), spentEur: (await budget.spentToday(a.id)) * EUR_PER_SAT,
      spentMonthEur: (await budget.spentThisMonth(a.id)) * EUR_PER_SAT
    }))))
  })

  admin.put('/agents/:id', async (req, res) => {
    const id = req.params.id
    if (!registry.get(id)) return res.status(404).json({ error: 'Unknown agent' })
    try {
      const rules = validateRules(req.body?.rules)
      const change = describe(registry.rulesFor(id), rules)
      if (!change) return res.json({ ok: true, message: 'No change' })
      registry.setRules(id, rules)
      await logChange(req, id, change)
      console.log(`⚙ ${who(req)} changed ${id}: ${change}`)
      res.json({ ok: true, message: change })
    } catch (e) { res.status(400).json({ error: (e as Error).message }) }
  })

  admin.post('/agents/:id/status', async (req, res) => {
    const id = req.params.id
    if (!registry.get(id)) return res.status(404).json({ error: 'Unknown agent' })
    const active = req.body?.active === true
    if (registry.isActive(id) === active) return res.json({ ok: true })
    registry.setActive(id, active)
    await logChange(req, id, active ? 'Agent reactivated' : 'Agent suspended')
    console.log(`⚙ ${who(req)} ${active ? 'reactivated' : 'suspended'} ${id}`)
    res.json({ ok: true })
  })

  admin.post('/agents/:id/reset-budget', async (req, res) => {
    const id = req.params.id
    if (!registry.get(id)) return res.status(404).json({ error: 'Unknown agent' })
    const before = (await budget.spentToday(id)) * EUR_PER_SAT
    await budget.reset(id)
    await logChange(req, id, `Today's spending reset (was ${fmt(before)})`, 'budget_reset')
    res.json({ ok: true })
  })

  admin.post('/agents/:id/key', async (req, res) => {
    const id = req.params.id
    if (!registry.get(id)) return res.status(404).json({ error: 'Unknown agent' })
    const apiKey = registry.rotateKey(id)
    await logChange(req, id, 'New API key issued, old key revoked')
    res.json({ ok: true, apiKey })
  })

  admin.post('/agents', async (req, res) => {
    const id = req.body?.id
    if (!validAgentId(id)) return res.status(400).json({ error: 'Agent name: 3–32 characters, lowercase letters, digits and dashes' })
    if (registry.get(id)) return res.status(409).json({ error: 'This agent already exists' })
    try {
      const rules = validateRules(req.body?.rules)
      const apiKey = registry.create(id, rules)
      await logChange(req, id, `Agent created · daily budget ${fmt(rules.daily_budget_eur)}`)
      res.json({ ok: true, apiKey })
    } catch (e) { res.status(400).json({ error: (e as Error).message }) }
  })
  // Validation depuis le tableau de bord (réservée à l'administrateur)
  // Sur cet ordinateur seulement (proxy non exposé), pas besoin du mot de passe pour décider
  app.post('/v1/admin/approvals/:id', (req, res, next) => EXPOSED ? requireAdmin(req, res, next) : next(), async (req, res) => {
    const r = requests.get(req.params.id)
    if (!r || r.status !== 'pending') return res.status(404).json({ error: 'This request is no longer waiting (already decided or expired)' })
    const approved = req.body?.approve === true
    const message = await engine.decide(r.id, approved, `${who(req)} (dashboard)`)
    res.json({ ok: true, message })
  })

  // Mandats en cours (administration) : liste et révocation
  admin.get('/mandates', (_req, res) => {
    const used = engine.usedByMandate(ledger.allSync())
    res.json(mandates.list().slice().reverse().map(m => ({ ...m, active: !m.revokedAt && m.validUntil > new Date().toISOString(), usedThisMonthEur: used(m.id) })))
  })
  admin.delete('/mandates/:id', async (req, res) => {
    const m = mandates.revoke(req.params.id, who(req))
    if (!m) return res.status(404).json({ error: 'Unknown or already revoked mandate' })
    await logChange(req, m.agentId, `Mandate ${m.id} revoked (${m.domain})`)
    res.json({ ok: true })
  })

  // Connexion d'un assistant IA : code à usage unique pour un agent
  admin.post('/agents/:id/pairing', async (req, res) => {
    const id = req.params.id
    if (!registry.get(id)) return res.status(404).json({ error: 'Unknown agent' })
    if (!registry.isActive(id)) return res.status(400).json({ error: 'Reactivate the agent first' })
    res.json({ ok: true, ...oauth.createPairing(id, who(req)), connectorUrl: MCP_URL })
  })
  admin.get('/connections', (_req, res) => res.json(oauth.connections()))
  admin.delete('/connections/:id', async (req, res) => {
    const g = oauth.revoke(req.params.id)
    if (!g) return res.status(404).json({ error: 'Unknown connection' })
    await logChange(req, g.agentId, `Assistant disconnected: ${g.clientName}`)
    res.json({ ok: true })
  })

  // Accès au tableau de bord (lecture seule) pour les personnes autorisées
  const viewerLog = (req: express.Request, change: string) =>
    record({ agentId: 'dashboard-access', url: 'admin://dashboard-access', amountSats: 0, amountEur: 0, decision: 'admin', reason: change, approvedBy: who(req) })
  admin.get('/viewers', (_req, res) => res.json(viewers.list()))
  admin.post('/viewers', async (req, res) => {
    const name = req.body?.name
    if (!validViewerName(name)) return res.status(400).json({ error: 'Name: 2–40 characters' })
    const { viewer, code } = viewers.create(String(name).trim(), who(req))
    await viewerLog(req, `Dashboard access granted to ${viewer.name}`)
    res.json({ ok: true, viewer, code })
  })
  admin.delete('/viewers/:id', async (req, res) => {
    const v = viewers.revoke(req.params.id)
    if (!v) return res.status(404).json({ error: 'Unknown access' })
    await viewerLog(req, `Dashboard access revoked for ${v.name}`)
    res.json({ ok: true })
  })
  app.use('/v1/admin', admin)

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
  createProxy().listen(PORT, HOST, () => {
    console.log(`Payment proxy ready on http://localhost:${PORT} — dashboard: http://localhost:${PORT}`)
    if (EXPOSED) console.log(`⚠ Public mode${PUBLIC_HOST ? ` (${PUBLIC_HOST})` : ''}: ${PUBLIC_READ ? 'dashboard readable by anyone' : 'dashboard only for the admin and people given an access code'}; admin page needs the admin password; demo API keys are disabled`)
    else console.log('Only reachable from this computer (set PROXY_HOST=0.0.0.0 to open it to the network)')
  })
}
