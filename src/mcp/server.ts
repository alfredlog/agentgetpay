// Serveur MCP d'AgentGetPay : n'importe quel assistant IA compatible MCP (Claude, ChatGPT,
// Copilot, Cursor, Gemini CLI, agents faits maison…) peut acheter des services à travers le proxy.
//
// L'IA n'a JAMAIS de clé de portefeuille : elle passe par le proxy, qui applique les règles,
// demande la validation humaine si besoin, paie et enregistre tout dans le journal d'audit.
//
// Deux modes :
//   MCP_TRANSPORT=stdio (par défaut) → l'application lance ce programme sur l'ordinateur.
//       La clé de l'agent vient de AGENTGETPAY_API_KEY.
//   MCP_TRANSPORT=http → serveur web sur http://127.0.0.1:5070/mcp.
//       Chaque client s'identifie comme UN agent, avec son budget : soit une clé d'agent
//       ("Authorization: Bearer agp_…"), soit un jeton obtenu par connexion OAuth (Claude, ChatGPT…).
//       Sans identifiant valide, on répond 401 avec l'adresse de la connexion OAuth : l'assistant affiche « Connecter ».
//
// Fichiers : l'IA ne lit ni n'écrit librement sur le disque. Elle ne voit que le dossier de travail
// (MCP_WORKSPACE, par défaut ./workspace). Dans un appel, {"$file": "facture.pdf"} est remplacé par
// le contenu du fichier ; les fichiers reçus (PDF…) sont enregistrés dans workspace/out/.
import 'dotenv/config'
import { readFile, writeFile, mkdir, readdir, stat, realpath } from 'node:fs/promises'
import { resolve, relative, join, basename, extname, sep } from 'node:path'
import express from 'express'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

const PROXY = (process.env.AGENTGETPAY_URL ?? 'http://127.0.0.1:5050').replace(/\/$/, '')
const WORKSPACE = resolve(process.env.MCP_WORKSPACE ?? 'workspace')
const MAX_FILE_MB = Number(process.env.MCP_MAX_FILE_MB ?? 25)
const MAX_TEXT = 20_000 // au-delà, la réponse est tronquée pour ne pas noyer l'IA
const log = (...a: unknown[]) => console.error('[mcp]', ...a) // jamais stdout : c'est le canal du protocole en mode stdio

// ---------------------------------------------------------------------------
// Dossier de travail (bac à sable)
// ---------------------------------------------------------------------------
function inWorkspace(name: string): string {
  const p = resolve(WORKSPACE, name)
  const rel = relative(WORKSPACE, p)
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..') || resolve(rel) === rel) {
    throw new Error(`"${name}" is outside the workspace folder`)
  }
  return p
}

// Remplace {"$file": "nom"} par le contenu du fichier en base64
async function attachFiles(value: unknown): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(attachFiles))
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.$file === 'string' && Object.keys(obj).length === 1) {
      const p = inWorkspace(obj.$file)
      const st = await stat(p).catch(() => undefined)
      if (!st?.isFile()) throw new Error(`File not found in the workspace: ${obj.$file}`)
      // Un lien symbolique ne doit pas mener hors du dossier de travail
      const real = await realpath(p)
      if (relative(await realpath(WORKSPACE), real).startsWith('..')) throw new Error(`"${obj.$file}" points outside the workspace folder`)
      if (st.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`${obj.$file} is larger than ${MAX_FILE_MB} MB`)
      return (await readFile(p)).toString('base64')
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = await attachFiles(v)
    return out
  }
  return value
}

// Enregistre les gros contenus base64 d'une réponse dans workspace/out/ et les remplace par {"$file": …}
async function extractFiles(value: unknown, hint = 'result'): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(v => extractFiles(v, hint)))
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const name = typeof obj.filename === 'string' ? basename(obj.filename) : hint
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = await extractFiles(v, name)
    return out
  }
  if (typeof value === 'string' && value.length > 2000 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) {
    const buf = Buffer.from(value, 'base64')
    const ext = buf.subarray(0, 5).toString('latin1') === '%PDF-' ? '.pdf' : extname(hint) || '.bin'
    const file = `${basename(hint, extname(hint)) || 'result'}${ext}`
    await mkdir(join(WORKSPACE, 'out'), { recursive: true })
    await writeFile(join(WORKSPACE, 'out', file), buf)
    return { $file: `out/${file}`, bytes: buf.length }
  }
  return value
}

// ---------------------------------------------------------------------------
// Appels au proxy
// ---------------------------------------------------------------------------
async function proxy(apiKey: string, path: string, body?: unknown) {
  const res = await fetch(`${PROXY}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).catch(() => { throw new Error(`AgentGetPay proxy unreachable at ${PROXY}`) })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, ok: res.ok, paidSats: Number(res.headers.get('X-Paid-Sats') ?? 0), json, text }
}

const result = (text: string, data?: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text }],
  ...(data ? { structuredContent: data } : {}),
  ...(isError ? { isError: true } : {})
})
const eur = (v: number) => `€${Number(v).toFixed(2)}`
const short = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (truncated, ${s.length} characters)` : s)

// ---------------------------------------------------------------------------
// Les outils, pour un agent donné (identifié par sa clé d'API)
// ---------------------------------------------------------------------------
function buildServer(apiKey: string) {
  const server = new McpServer({ name: 'agentgetpay', version: '1.0.0' }, {
    instructions:
      'AgentGetPay lets you buy paid online services (HTTP 402, paid in BSV) within your company\'s rules. ' +
      'Before buying, call check_budget, then get_price for each paid call. Always give a clear purpose: it is ' +
      'stored in the audit log. Payments above the approval threshold wait for a human to approve them on their ' +
      'phone (up to 2 minutes). If a payment is refused, explain the reason to the user instead of retrying. ' +
      'To send a file, put it in the workspace and use {"$file": "name.pdf"} in the body; received files are saved in out/.'
  })

  server.registerTool('check_budget', {
    title: 'Check budget',
    description: 'Shows your spending rules, how much you can still spend today, and your last 10 operations.',
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => {
    const r = await proxy(apiKey, '/v1/me')
    if (!r.ok) return result(`Cannot read the budget: ${r.json?.error ?? r.status}`, undefined, true)
    const m = r.json
    const lines = [
      `Agent: ${m.agentId}${m.active ? '' : ' (SUSPENDED: every payment will be refused)'}`,
      `Spent today: ${eur(m.spentEur)} of ${eur(m.rules?.daily_budget_eur ?? 0)}, remaining ${eur(m.remainingEur)}`,
      `Max per payment: ${eur(m.rules?.max_per_payment_eur ?? 0)} · human approval above ${eur(m.rules?.approval_above_eur ?? 0)}`,
      `Allowed domains: ${(m.rules?.allowed_domains ?? []).join(', ')}`,
      'Recent operations:',
      ...m.recent.map((e: any) => `- ${new Date(e.time).toLocaleString('en-GB', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' })} ${e.decision} ${eur(e.amountEur)} ${e.url}${e.reason ? ` (${e.reason})` : ''}`)
    ]
    return result(lines.join('\n'), m)
  })

  server.registerTool('get_price', {
    title: 'Get price',
    description: 'Asks a service for its price WITHOUT paying, and tells you whether your rules would allow, refuse, or require human approval.',
    inputSchema: {
      url: z.string().url().describe('Full URL of the service, e.g. https://pdf-libre.de/agent/v1/compress'),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('POST').describe('HTTP method you will use')
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async ({ url, method }) => {
    const r = await proxy(apiKey, '/v1/fetch', { url, method, dryRun: true })
    if (!r.ok) return result(`No price: ${r.json?.reason ?? r.json?.error ?? r.status}`, r.json, true)
    const q = r.json
    if (!q.paymentRequired) return result(`No payment required (status ${q.status}).`, q)
    const verdict = q.decision === 'allow' ? 'allowed, will be paid automatically'
      : q.decision === 'needs_approval' ? 'needs human approval' : `refused: ${q.reason}`
    return result(`${q.description ?? url}: ${q.priceSats} sats (${eur(q.priceEur)}). Your rules: ${verdict}.`, q)
  })

  server.registerTool('pay_and_fetch', {
    title: 'Pay and fetch',
    description: 'Calls a service. If it asks for payment (HTTP 402), the company proxy checks your rules, may ask a human to approve, pays in BSV and returns the result. Free services are simply called. Every call is recorded in the audit log.',
    inputSchema: {
      url: z.string().url().describe('Full URL of the service'),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
      body: z.record(z.unknown()).optional().describe('JSON body. Use {"$file": "name.pdf"} to send a file from the workspace.'),
      purpose: z.string().min(5).max(200).describe('Why you need this, in one sentence. Stored in the audit log and shown to the approver.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ url, method, body, purpose }) => {
    let payload: unknown
    try { payload = body === undefined ? undefined : await attachFiles(body) } catch (e) { return result((e as Error).message, undefined, true) }
    log(`${method} ${url} — ${purpose}`)
    const r = await proxy(apiKey, '/v1/fetch', { url, method, body: payload, purpose })
    if (!r.ok) {
      const reason = r.json?.reason ?? r.json?.error ?? `HTTP ${r.status}`
      return result(`Not done: ${reason}`, { status: r.status, decision: r.json?.decision, reason }, true)
    }
    const data = r.json !== undefined ? await extractFiles(r.json) : undefined
    const head = r.paidSats ? `Paid ${r.paidSats} sats. ` : 'No payment needed. '
    const files = JSON.stringify(data ?? '').match(/"\$file":"[^"]+"/g)?.map(f => f.slice(9, -1)) ?? []
    const text = head + (files.length ? `Files saved in the workspace: ${files.join(', ')}. ` : '') + '\n' + short(data !== undefined ? JSON.stringify(data, null, 2) : r.text)
    return result(text, { paidSats: r.paidSats, status: r.status, ...(data && typeof data === 'object' && !Array.isArray(data) ? { response: data } : {}) })
  })

  server.registerTool('list_workspace_files', {
    title: 'List workspace files',
    description: 'Lists the files you can send ({"$file": "name"}) and the files you received (in out/).',
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => {
    await mkdir(join(WORKSPACE, 'out'), { recursive: true })
    const walk = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true }))
      .filter(d => !d.name.startsWith('.'))
      .map(d => d.isDirectory() ? walk(join(dir, d.name)) : Promise.resolve([relative(WORKSPACE, join(dir, d.name))])))).flat()
    const files = await walk(WORKSPACE)
    return result(files.length ? files.join('\n') : 'The workspace is empty.', { files })
  })

  return server
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
await mkdir(WORKSPACE, { recursive: true })

if ((process.env.MCP_TRANSPORT ?? 'stdio') === 'http') {
  const HOST = process.env.MCP_HOST ?? '127.0.0.1'
  const PORT = Number(process.env.MCP_PORT ?? 5070)
  const app = express()
  app.use(express.json({ limit: '60mb' }))

  // Où se trouve la connexion OAuth (servie par le proxy, à son adresse publique)
  const publicHost = process.env.PROXY_PUBLIC_HOST?.trim()
  const issuer = (process.env.OAUTH_ISSUER ?? (publicHost ? `https://${publicHost}` : PROXY)).replace(/\/$/, '')
  const resourceMetadata = `${issuer}/.well-known/oauth-protected-resource/mcp`
  const unauthorized = (res: express.Response, message: string, invalid = false) => res.status(401)
    .set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadata}"${invalid ? ', error="invalid_token"' : ''}`)
    .json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null })

  // Certains clients cherchent la description OAuth sur l'adresse du serveur MCP lui-même : on relaie celle du proxy
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], async (_req, res) => {
    const r = await fetch(`${PROXY}/.well-known/oauth-protected-resource/mcp`).catch(() => undefined)
    if (!r?.ok) return res.status(503).json({ error: 'AgentGetPay proxy unreachable' })
    res.set('Access-Control-Allow-Origin', '*').json(await r.json())
  })

  // Les assistants qui tournent dans un navigateur ont besoin de lire l'en-tête WWW-Authenticate
  app.use('/mcp', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id')
    res.set('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  // Le jeton est-il valable ? On demande au proxy (il connaît les clés d'agent et les jetons OAuth).
  // Petit cache de 30 s pour ne pas interroger le proxy à chaque message.
  const valid = new Map<string, number>()
  const checkToken = async (t: string) => {
    if ((valid.get(t) ?? 0) > Date.now()) return true
    const r = await fetch(`${PROXY}/v1/me`, { headers: { Authorization: `Bearer ${t}` } }).catch(() => undefined)
    if (!r) throw new Error('proxy unreachable')
    if (r.status === 401) { valid.delete(t); return false }
    if (valid.size > 1000) valid.clear()
    valid.set(t, Date.now() + 30_000)
    return true
  }

  // Mode sans session : un serveur MCP neuf par requête, lié à l'agent qui appelle
  app.post('/mcp', async (req, res) => {
    const auth = req.get('Authorization') ?? ''
    if (!auth.startsWith('Bearer ') || auth.length < 12) return unauthorized(res, 'Sign in required: connect this assistant to AgentGetPay')
    const t = auth.slice(7)
    try { if (!(await checkToken(t))) return unauthorized(res, 'Invalid or expired token: connect again', true) }
    catch { return res.status(503).json({ jsonrpc: '2.0', error: { code: -32002, message: 'AgentGetPay proxy unreachable' }, id: null }) }
    const server = buildServer(t)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      // Protection contre le "DNS rebinding" : seules ces adresses peuvent appeler le serveur
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${PORT}`, `localhost:${PORT}`, ...(process.env.MCP_ALLOWED_HOSTS?.split(',') ?? [])]
    })
    res.on('close', () => { void transport.close(); void server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })
  app.all('/mcp', (req, res) => {
    if (!req.get('Authorization')) return unauthorized(res, 'Sign in required: connect this assistant to AgentGetPay')
    res.status(405).set('Allow', 'POST').json({ error: 'Use POST' })
  })

  app.listen(PORT, HOST, () => log(`AgentGetPay MCP server on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/mcp (proxy: ${PROXY}, workspace: ${WORKSPACE})`))
} else {
  const key = process.env.AGENTGETPAY_API_KEY
  if (!key) {
    log('AGENTGETPAY_API_KEY is missing: set it to the API key of the agent this assistant acts as.')
    process.exit(1)
  }
  await buildServer(key).connect(new StdioServerTransport())
  log(`AgentGetPay MCP server ready (stdio, proxy: ${PROXY}, workspace: ${WORKSPACE})`)
}
