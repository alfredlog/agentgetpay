// Serveur MCP d'AgentGetPay : n'importe quel assistant IA compatible MCP (Claude, ChatGPT,
// Copilot, Cursor, Gemini CLI, home-made agents…) can buy services through the proxy.
//
// The AI NEVER holds a wallet key: it goes through the proxy, which applies the rules,
// asks for human approval when needed, pays, and records everything in the audit log.
//
// Deux modes :
//   MCP_TRANSPORT=stdio (default) → the app starts this program on the computer.
//       The agent key comes from AGENTGETPAY_API_KEY.
//   MCP_TRANSPORT=http → web server on http://127.0.0.1:5070/mcp.
//       Each client identifies as ONE agent, with its budget: either an agent key
//       ("Authorization: Bearer agp_…"), or a token obtained by signing in with OAuth (Claude, ChatGPT…).
//       Without valid credentials we answer 401 with the OAuth sign-in address: the assistant shows "Connect".
//
// Files: the AI does not read or write freely on disk. It only sees the working folder
// (MCP_WORKSPACE, ./workspace by default; in http mode, one subfolder per agent). In http mode the assistant
// works remotely: it gives the user an upload link (in/) and download links (out/). In a call, {"$file": "invoice.pdf"} is replaced by
// the file content; received files (PDF…) are saved in workspace/out/.
import 'dotenv/config'
import { readFile, writeFile, mkdir, readdir, stat, realpath } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, relative, join, basename, extname, sep } from 'node:path'
import express from 'express'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { FileLinks } from './file-links.js'

const PROXY = (process.env.AGENTGETPAY_URL ?? 'http://127.0.0.1:5050').replace(/\/$/, '')
const WORKSPACE = resolve(process.env.MCP_WORKSPACE ?? 'workspace')
const MAX_FILE_MB = Number(process.env.MCP_MAX_FILE_MB ?? 25)
const MAX_WORKSPACE_MB = Number(process.env.MCP_MAX_WORKSPACE_MB ?? 200) // per agent, in connector mode
const MAX_TEXT = 20_000 // beyond this, the response is truncated so the AI is not flooded
const log = (...a: unknown[]) => console.error('[mcp]', ...a) // never stdout: it is the protocol channel in stdio mode

// ---------------------------------------------------------------------------
// Working folder (sandbox)
// ---------------------------------------------------------------------------
function inWorkspace(ws: string, name: string): string {
  const p = resolve(ws, name)
  const rel = relative(ws, p)
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..') || resolve(rel) === rel) {
    throw new Error(`"${name}" is outside the workspace folder`)
  }
  return p
}

// Replaces {"$file": "name"} with the file content in base64
async function attachFiles(ws: string, value: unknown): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(v => attachFiles(ws, v)))
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.$file === 'string' && Object.keys(obj).length === 1) {
      const p = inWorkspace(ws, obj.$file)
      const st = await stat(p).catch(() => undefined)
      if (!st?.isFile()) throw new Error(`File not found in the workspace: ${obj.$file}`)
      // A symbolic link must not lead outside the working folder
      const real = await realpath(p)
      if (relative(await realpath(ws), real).startsWith('..')) throw new Error(`"${obj.$file}" points outside the workspace folder`)
      if (st.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`${obj.$file} is larger than ${MAX_FILE_MB} MB`)
      return (await readFile(p)).toString('base64')
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = await attachFiles(ws, v)
    return out
  }
  return value
}

// Saves large base64 contents of a response in workspace/out/ and replaces them with {"$file": …}
async function extractFiles(ws: string, value: unknown, hint = 'result'): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(v => extractFiles(ws, v, hint)))
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const name = typeof obj.filename === 'string' ? basename(obj.filename) : hint
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = await extractFiles(ws, v, name)
    return out
  }
  if (typeof value === 'string' && value.length > 2000 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) {
    const buf = Buffer.from(value, 'base64')
    const ext = buf.subarray(0, 5).toString('latin1') === '%PDF-' ? '.pdf' : extname(hint) || '.bin'
    // Never overwrite a previous result: report.pdf, report-2.pdf…
    const stem = basename(hint, extname(hint)) || 'result'
    await mkdir(join(ws, 'out'), { recursive: true })
    let file = `${stem}${ext}`
    for (let i = 2; await stat(join(ws, 'out', file)).then(() => true, () => false); i++) file = `${stem}-${i}${ext}`
    await writeFile(join(ws, 'out', file), buf)
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
  return { status: res.status, ok: res.ok, paidSats: Number(res.headers.get('X-Paid-Sats') ?? 0), refundedSats: Number(res.headers.get('X-Refunded-Sats') ?? 0), json, text }
}

const result = (text: string, data?: Record<string, unknown>, isError = false) => ({
  content: [{ type: 'text' as const, text }],
  ...(data ? { structuredContent: data } : {}),
  ...(isError ? { isError: true } : {})
})
const eur = (v: number) => `€${Number(v).toFixed(2)}`
const short = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (truncated, ${s.length} characters)` : s)

// ---------------------------------------------------------------------------
// The tools, for one agent (identified by its API key)
// ws: its working folder. links: in connector mode, upload and download links.
// ---------------------------------------------------------------------------
interface Ctx { ws: string; agentId?: string; links?: FileLinks }

function buildServer(apiKey: string, ctx: Ctx = { ws: WORKSPACE }) {
  const { ws, links } = ctx
  const server = new McpServer({ name: 'agentgetpay', version: '1.0.0' }, {
    instructions:
      'AgentGetPay lets you buy paid online services (HTTP 402, paid in BSV) within your company\'s rules. ' +
      'Use these tools, never a web browser, for any paid service: payments must go through the company\'s spend control. ' +
      'Call list_services to see the approved services and their addresses. Before buying, call check_budget, then get_price for each paid call. Always give a clear purpose: it is ' +
      'stored in the audit log. Payments above the approval threshold need a human: they may approve within seconds or days. ' +
      'If the answer is not immediate you get a request id (R-…): do not retry, continue with other work, and use check_request later; ' +
      'the purchase is made automatically once approved. For recurring purchases (subscriptions), ask once with request_mandate. ' +
      'If a merchant only takes cards (no HTTP 402), ask for a single-use card with request_virtual_card, then pay with it at that merchant only. ' +
      'To cancel an order, call the merchant\'s cancel endpoint with pay_and_fetch: refunds come back to the company automatically. ' +
      'If a payment is refused, explain the reason to the user instead of retrying. ' +
      'To send a file, use {"$file": "name.pdf"} in the body; received files are saved in out/. ' +
      (links
        ? 'You run remotely and cannot read files from the user\'s computer or from the chat. When the user wants a file of theirs processed, ' +
          'call request_file_upload, give them the link, and wait until they say the upload is done; their files then appear in in/. ' +
          'Always give the user the download link of each file you produce.'
        : 'Files are taken from the workspace folder on this computer.')
  })
  // Download link for a file in the folder (connector mode)
  const download = (file: string) => links ? links.downloadLink(ws, file, ctx.agentId ?? 'agent').url : undefined

  // Catalog of services approved by the company (config/services.json)
  server.registerTool('list_services', {
    title: 'List approved services',
    description: 'Lists the paid services the company has approved (for example PDF compression and merging), with their API addresses and prices. Call this first when the user asks for something a paid service can do.',
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, async () => {
    const path = process.env.MCP_SERVICES ?? 'config/services.json'
    const catalog: { name: string; description: string; discovery: string; example?: string }[] = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
    if (!catalog.length) return result('No service is listed in the catalog.')
    const parts = await Promise.all(catalog.map(async s => {
      const menu = await fetch(s.discovery, { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : undefined).catch(() => undefined)
      return `## ${s.name}\n${s.description}\nAPI: ${s.discovery}${s.example ? `\nExample: ${s.example}` : ''}\n${menu ? `Endpoints and prices: ${short(JSON.stringify(menu))}` : '(price list unavailable right now)'}`
    }))
    return result(parts.join('\n\n'), { services: catalog })
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
      `Spent today: ${eur(m.spentEur)} of ${eur(m.rules?.daily_budget_eur ?? 0)}${m.rules?.monthly_budget_eur !== undefined ? ` · this month: ${eur(m.spentMonthEur)} of ${eur(m.rules.monthly_budget_eur)}` : ''} · you can still spend ${eur(m.remainingEur)} today`,
      ...(m.categories ? [`Allowed purchase categories (others are refused): ${Object.entries(m.categories).map(([k, c]: [string, any]) => `${k}${c.max_unit_price_eur !== undefined ? ` max ${eur(c.max_unit_price_eur)}/unit` : ''}${c.monthly_budget_eur !== undefined ? `, ${eur(c.spentMonthEur)} of ${eur(c.monthly_budget_eur)} this month` : ''}${c.approval_above_eur !== undefined ? `, approval above ${eur(c.approval_above_eur)}` : ''}`).join('; ')}`] : []),
      ...(m.rules?.shipping_addresses ? [`Goods can only be delivered to: ${m.rules.shipping_addresses.map((a: any) => `${a.street}, ${a.postalCode} ${a.city}, ${a.country}`).join(' | ')}`] : []),
      `Max per payment: ${eur(m.rules?.max_per_payment_eur ?? 0)} · human approval above ${eur(m.rules?.approval_above_eur ?? 0)}`,
      `Allowed domains: ${(m.rules?.allowed_domains ?? []).join(', ')}`,
      ...(m.mandates?.length ? [`Active standing approvals: ${m.mandates.map((x: any) => `${x.id} ${x.domain}${x.category ? ` ${x.category}` : ''} up to ${eur(x.maxEurPerMonth)}/month (${eur(x.usedThisMonthEur)} used)`).join('; ')}`] : []),
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

  // Presents a service response to the assistant (saved files, download links)
  const present = async (r: Awaited<ReturnType<typeof proxy>>, prefix = '') => {
    const data = r.json !== undefined ? await extractFiles(ws, r.json) : undefined
    const head = prefix + (r.paidSats ? `Paid ${r.paidSats} sats. ` : 'No payment needed. ') +
      (r.refundedSats ? `Refund received: ${r.refundedSats} sats were paid back to the company wallet. ` : '')
    const files = JSON.stringify(data ?? '').match(/"\$file":"[^"]+"/g)?.map(f => f.slice(9, -1)) ?? []
    const downloads = files.map(f => ({ file: f, url: download(f) })).filter(d => d.url)
    const text = head + (files.length ? `Files saved: ${files.join(', ')}. ` : '') +
      (downloads.length ? `\nDownload links for the user (valid 24 h):\n${downloads.map(d => `- ${d.file}: ${d.url}`).join('\n')}` : '') +
      '\n' + short(data !== undefined ? JSON.stringify(data, null, 2) : r.text)
    return result(text, { paidSats: r.paidSats, status: r.status, ...(r.refundedSats ? { refundedSats: r.refundedSats } : {}), ...(downloads.length ? { downloads } : {}), ...(data && typeof data === 'object' && !Array.isArray(data) ? { response: data } : {}) })
  }
  const pendingText = (j: any) => `Waiting for human approval: request ${j.requestId ?? j.id} (${j.reason}). A person may answer in minutes or in days (open until ${j.expiresAt}). ` +
    'Do NOT retry this purchase. Tell the user it is waiting for approval and continue with other tasks. ' +
    'When it is approved, the purchase is made automatically; call check_request later to get the result.'

  server.registerTool('pay_and_fetch', {
    title: 'Pay and fetch',
    description: 'Calls a service. If it asks for payment (HTTP 402), the company proxy checks your rules, may ask a human to approve, pays in BSV and returns the result. Free services are simply called. Every call is recorded in the audit log. Always use this tool for paid services, never a web browser: company payments must go through this spend control. If a human must approve, you get a request id at once: continue with other work and use check_request later.',
    inputSchema: {
      url: z.string().url().describe('Full URL of the service'),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
      body: z.record(z.unknown()).optional().describe('JSON body. Use {"$file": "name.pdf"} to send a file from the workspace.'),
      purpose: z.string().min(5).max(200).describe('Why you need this, in one sentence. Stored in the audit log and shown to the approver.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async ({ url, method, body, purpose }) => {
    let payload: unknown
    try { payload = body === undefined ? undefined : await attachFiles(ws, body) } catch (e) { return result((e as Error).message, undefined, true) }
    log(`${method} ${url} — ${purpose}`)
    // Wait for an approval 20 s at most: after that the request stays open and the assistant moves on
    const r = await proxy(apiKey, '/v1/fetch', { url, method, body: payload, purpose, waitSeconds: 20 })
    if (r.status === 202 && r.json?.decision === 'pending_approval') return result(pendingText(r.json), { status: 202, ...r.json })
    if (!r.ok) {
      const reason = r.json?.reason ?? r.json?.error ?? `HTTP ${r.status}`
      return result(`Not done: ${reason}`, { status: r.status, decision: r.json?.decision, reason }, true)
    }
    return present(r)
  })

  server.registerTool('check_request', {
    title: 'Check an approval request',
    description: 'Shows the status of a purchase or mandate that was waiting for human approval. If the purchase was approved and made, returns its result (like pay_and_fetch).',
    inputSchema: { request_id: z.string().regex(/^R-[A-Z0-9]{6}$/).describe('The request id, e.g. R-7K2Q9D') },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ request_id }) => {
    const r = await proxy(apiKey, `/v1/requests/${request_id}`)
    if (!r.ok) return result(`Cannot read ${request_id}: ${r.json?.error ?? r.status}`, undefined, true)
    const q = r.json
    if (q.status === 'pending') return result(pendingText(q), q)
    if (q.status === 'rejected') return result(`${q.id} was rejected by ${q.decidedBy}. Do not buy it another way; tell the user.`, q)
    if (q.status === 'expired') return result(`${q.id} expired: nobody approved it in time. Ask the user before trying again.`, q)
    if (q.status === 'approved') return result(`${q.id} was approved by ${q.decidedBy} and is being executed. Check again in a moment.`, q)
    if (q.kind === 'card') {
      if (q.status !== 'completed') return result(`${q.id} was approved but no card was issued: ${q.result?.error}`, q, true)
      const c = await proxy(apiKey, `/v1/requests/${request_id}/result`)
      if (!c.ok) return result(`${q.id}: virtual card issued (approved by ${q.decidedBy}). ${c.json?.error ?? ''}`, q, !c.ok)
      return result(cardText(c.json, `${q.id} approved by ${q.decidedBy}. `), { card: c.json })
    }
    if (q.kind === 'mandate') return result(q.status === 'completed' ? `Mandate ${q.result?.mandateId} is active (approved by ${q.decidedBy}): matching payments no longer wait for approval.` : `Mandate request failed: ${q.result?.error}`, q, q.status !== 'completed')
    if (q.status === 'failed' && !q.result?.status) return result(`${q.id} was approved but not executed: ${q.result?.error}`, q, true)
    const out = await proxy(apiKey, `/v1/requests/${request_id}/result`)
    if (q.status === 'failed') return result(`${q.id} was approved by ${q.decidedBy}, but not completed: ${q.result?.error ?? out.json?.reason ?? out.status}`, q, true)
    return present(out, `${q.id} was approved by ${q.decidedBy} and executed. `)
  })

  server.registerTool('list_requests', {
    title: 'List approval requests',
    description: 'Lists your recent purchases and mandates that needed human approval, with their status.',
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => {
    const r = await proxy(apiKey, '/v1/requests')
    if (!r.ok) return result(`Cannot list requests: ${r.json?.error ?? r.status}`, undefined, true)
    const lines = (r.json as any[]).map(q => `- ${q.id} ${q.status}${q.kind === 'mandate' ? ` mandate ${q.mandate?.domain} ${eur(q.mandate?.maxEurPerMonth)}/month` : ` ${eur(q.amountEur ?? 0)} ${q.order?.merchant ?? q.url}`}${q.decidedBy ? ` (by ${q.decidedBy})` : ''}`)
    return result(lines.length ? lines.join('\n') : 'No approval requests.', { requests: r.json })
  })

  const cardText = (c: any, prefix = '') => `${prefix}Virtual card issued — single use, only at ${c.merchantName} (${c.merchantDomain}), limit ${eur(c.limitEur)}.\n` +
    `Number: ${c.number}\nExpiry: ${String(c.expMonth).padStart(2, '0')}/${c.expYear}\nCVC: ${c.cvc}\n` +
    'Use it ONLY for this purchase, at this merchant: pass it to the merchant\'s checkout (for the demo market: add "card": {"number", "cvc", "expMonth", "expYear"} to the order body with pay_and_fetch). ' +
    'Never show the full number to anyone else. Any other use is declined in real time by the company.'

  server.registerTool('request_virtual_card', {
    title: 'Ask for a virtual card',
    description: 'For merchants that do not accept BSV (hotels, airlines, shops paid by card): asks the company for a single-use virtual card, limited to one merchant and one amount. The company rules and approvals apply exactly like for BSV payments; every charge is checked in real time. If a human must approve, you get a request id: continue with other work and use check_request later to get the card.',
    inputSchema: {
      merchant_name: z.string().min(2).describe('Merchant name, e.g. City Lodge München'),
      merchant_domain: z.string().describe('Merchant domain (must be one of your allowed domains), e.g. shop.example.com'),
      category: z.string().optional().describe('Purchase category, e.g. travel.hotel, office.supplies, software.subscription'),
      amount_eur: z.number().positive().describe('Price in euros'),
      items: z.array(z.object({ name: z.string(), quantity: z.number().int().positive(), unit_price_eur: z.number().nonnegative(), unit: z.string().optional() })).optional()
        .describe('What you buy, e.g. [{"name": "Compact room", "quantity": 2, "unit_price_eur": 89, "unit": "night"}]. Must add up to amount_eur.'),
      tolerance_percent: z.number().min(0).max(20).default(0).describe('Extra allowed on the card (a hotel may hold a bit more), 0–20 %'),
      valid_days: z.number().int().min(1).max(60).default(1).describe('How long the card stays valid (a hotel may charge at check-out)'),
      purpose: z.string().min(5).max(200).describe('Why you need this, in one sentence')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ merchant_name, merchant_domain, category, amount_eur, items, tolerance_percent, valid_days, purpose }) => {
    const r = await proxy(apiKey, '/v1/cards', {
      merchantName: merchant_name, merchantDomain: merchant_domain, category, amountEur: amount_eur, tolerancePercent: tolerance_percent, validDays: valid_days, purpose, waitSeconds: 20,
      items: items?.map(i => ({ name: i.name, quantity: i.quantity, unitPriceEur: i.unit_price_eur, unit: i.unit }))
    })
    if (r.status === 202) return result(pendingText(r.json), { status: 202, ...r.json })
    if (!r.ok) return result(`No card: ${r.json?.reason ?? r.json?.error ?? r.status}`, r.json, true)
    return result(cardText(r.json.card), { card: r.json.card })
  })

  server.registerTool('request_mandate', {
    title: 'Ask for a standing approval',
    description: 'For recurring purchases (a monthly subscription, an API billed every month): asks a human ONCE to approve payments to one merchant up to a monthly amount. Once approved, matching payments no longer wait for approval (budgets and other rules still apply).',
    inputSchema: {
      domain: z.string().describe('Merchant domain, e.g. shop.example.com (must be one of your allowed domains)'),
      category: z.string().optional().describe('Purchase category covered, e.g. software.subscription'),
      max_eur_per_month: z.number().positive().describe('Maximum covered per month, in euros'),
      months: z.number().int().min(1).max(24).default(12).describe('How long the approval lasts'),
      purpose: z.string().min(5).max(200).describe('Why this recurring purchase is needed')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ domain, category, max_eur_per_month, months, purpose }) => {
    const r = await proxy(apiKey, '/v1/mandates', { domain, category, maxEurPerMonth: max_eur_per_month, months, purpose, waitSeconds: 20 })
    if (r.status >= 400) return result(`Not requested: ${r.json?.error ?? r.status}`, undefined, true)
    const q = r.json
    if (q.status === 'pending') return result(`Standing approval requested: ${q.id}. A human must approve it (open until ${q.expiresAt}). Continue with other work and use check_request later.`, q)
    if (q.status === 'completed') return result(`Approved by ${q.decidedBy}: mandate ${q.result?.mandateId} is active.`, q)
    return result(`Mandate request ${q.status}${q.decidedBy ? ` by ${q.decidedBy}` : ''}.`, q, true)
  })

  server.registerTool('list_workspace_files', {
    title: 'List workspace files',
    description: 'Lists the files you can send ({"$file": "name"}) and the files you received (in out/).',
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => {
    await mkdir(join(ws, 'out'), { recursive: true })
    const walk = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true }))
      .filter(d => !d.name.startsWith('.'))
      .map(d => d.isDirectory() ? walk(join(dir, d.name)) : Promise.resolve([relative(ws, join(dir, d.name))])))).flat()
    const files = await walk(ws)
    return result(files.length ? files.join('\n') : 'The workspace is empty.', { files })
  })

  if (links) {
    server.registerTool('request_file_upload', {
      title: 'Ask the user for files',
      description: 'Use this whenever the user wants one of their files processed (e.g. "compress my invoice"), including a file attached to the chat, which you cannot forward yourself. Creates a private link (valid 15 minutes) where the user uploads the file. Give the link to the user and wait until they confirm; the files then appear in in/ (see list_workspace_files) and can be sent with {"$file": "in/name.pdf"}. Do not open a web browser for this.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    }, async () => {
      const l = links.uploadLink(ws, ctx.agentId ?? 'agent')
      return result(`Give this link to the user: ${l.url}\nIt expires in 15 minutes. Wait until they say the upload is done, then call list_workspace_files.`, l)
    })

    server.registerTool('get_download_link', {
      title: 'Get a download link',
      description: 'Creates a private download link (valid 24 hours) for a file in the workspace, so the user can get it, e.g. "out/report.pdf".',
      inputSchema: { file: z.string().describe('Path in the workspace, e.g. out/report.pdf') },
      annotations: { readOnlyHint: true, openWorldHint: false }
    }, async ({ file }) => {
      try {
        const p = inWorkspace(ws, file)
        if (!(await stat(p).catch(() => undefined))?.isFile()) return result(`File not found: ${file}`, undefined, true)
        const l = links.downloadLink(ws, relative(ws, p), ctx.agentId ?? 'agent')
        return result(`Download link for ${file} (valid 24 h): ${l.url}`, l)
      } catch (e) { return result((e as Error).message, undefined, true) }
    })
  }

  return server
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
await mkdir(WORKSPACE, { recursive: true })

if ((process.env.MCP_TRANSPORT ?? 'stdio') === 'http') {
  const HOST = process.env.MCP_HOST ?? '127.0.0.1'
  const PORT = Number(process.env.MCP_PORT ?? 5070)
  const app = express()
  const publicHost = process.env.PROXY_PUBLIC_HOST?.trim()

  // Upload and download links (before the JSON parser: an uploaded file stays raw)
  const publicBase = (process.env.MCP_PUBLIC_BASE ?? (publicHost ? `https://${publicHost}` : `http://127.0.0.1:${PORT}`)).replace(/\/$/, '')
  const links = new FileLinks(publicBase, MAX_FILE_MB, MAX_WORKSPACE_MB)
  app.use(links.router(log))

  app.use(express.json({ limit: '60mb' }))

  // Where the OAuth sign-in lives (served by the proxy, at its public address)
  const issuer = (process.env.OAUTH_ISSUER ?? (publicHost ? `https://${publicHost}` : PROXY)).replace(/\/$/, '')
  const resourceMetadata = `${issuer}/.well-known/oauth-protected-resource/mcp`
  const unauthorized = (res: express.Response, message: string, invalid = false) => res.status(401)
    .set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadata}"${invalid ? ', error="invalid_token"' : ''}`)
    .json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null })

  // Some clients look for the OAuth description on the MCP server's own address: relay the proxy's one
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], async (_req, res) => {
    const r = await fetch(`${PROXY}/.well-known/oauth-protected-resource/mcp`).catch(() => undefined)
    if (!r?.ok) return res.status(503).json({ error: 'AgentGetPay proxy unreachable' })
    res.set('Access-Control-Allow-Origin', '*').json(await r.json())
  })

  // Assistants running in a browser need to read the WWW-Authenticate header
  app.use('/mcp', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id')
    res.set('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  // Is the token valid? Ask the proxy (it knows the agent keys and the OAuth tokens).
  // Small 30 s cache so the proxy is not queried on every message.
  // Returns the agent bound to the token, or undefined if the token is not valid.
  const valid = new Map<string, { exp: number; agentId: string }>()
  const checkToken = async (t: string): Promise<string | undefined> => {
    const hit = valid.get(t)
    if (hit && hit.exp > Date.now()) return hit.agentId
    const r = await fetch(`${PROXY}/v1/me`, { headers: { Authorization: `Bearer ${t}` } }).catch(() => undefined)
    if (!r) throw new Error('proxy unreachable')
    if (r.status === 401) { valid.delete(t); return undefined }
    const agentId = String(((await r.json().catch(() => ({}))) as { agentId?: string }).agentId ?? '')
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(agentId)) throw new Error('unexpected answer from the proxy')
    if (valid.size > 1000) valid.clear()
    valid.set(t, { exp: Date.now() + 30_000, agentId })
    return agentId
  }

  // Stateless mode: a fresh MCP server per request, bound to the calling agent
  app.post('/mcp', async (req, res) => {
    const auth = req.get('Authorization') ?? ''
    if (!auth.startsWith('Bearer ') || auth.length < 12) return unauthorized(res, 'Sign in required: connect this assistant to AgentGetPay')
    const t = auth.slice(7)
    let agentId: string | undefined
    try { agentId = await checkToken(t); if (!agentId) return unauthorized(res, 'Invalid or expired token: connect again', true) }
    catch { return res.status(503).json({ jsonrpc: '2.0', error: { code: -32002, message: 'AgentGetPay proxy unreachable' }, id: null }) }
    // Each agent has its own folder: an assistant never sees another agent's files
    const ws = join(WORKSPACE, agentId)
    await mkdir(ws, { recursive: true })
    const server = buildServer(t, { ws, agentId, links })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      // Protection against "DNS rebinding": only these addresses may call the server
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
