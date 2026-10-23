// OAuth 2.1 sign-in for AI assistants (Claude, ChatGPT, Cursor…) that connect to the remote MCP server.
//
// The flow, as the employee sees it:
//   1. In their assistant, they add the connector https://agentpay.example.com/mcp and click "Connect".
//   2. The assistant sends them to the AgentGetPay /authorize page. They type the CONNECTION CODE the administrator
//      created for their agent (single use, valid 15 minutes). The administrator can also connect directly
//      with the admin password and the agent name.
//   3. The assistant receives a token bound to THAT agent: it spends within that agent's budget and rules.
//
// Standards followed: discovery (RFC 9728 + RFC 8414), dynamic client registration (RFC 7591),
// mandatory PKCE S256, short access tokens (1 h), single-use refresh tokens (rotation).
// Nothing is stored in clear: only hashes of codes and tokens are kept.
import express from 'express'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const b64urlSha256 = (s: string) => createHash('sha256').update(s).digest('base64url')
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

const ACCESS_TTL = 3600 // 1 h
const REFRESH_TTL = 30 * 24 * 3600 // 30 jours
const CODE_TTL = 5 * 60_000
const PAIRING_TTL = 15 * 60_000
const PENDING_TTL = 15 * 60_000
const MAX_CLIENTS = 500

interface Client { client_id: string; client_name: string; redirect_uris: string[]; created_at: string }
export interface Grant {
  id: string; agentId: string; clientId: string; clientName: string
  createdAt: string; lastUsedAt: string; by: string
  refreshHash: string; refreshExp: number
}
interface Access { hash: string; grantId: string; exp: number }
interface State { clients: Client[]; grants: Grant[]; access: Access[] }

interface Pairing { agentId: string; exp: number; by: string }
interface Pending { clientId: string; redirectUri: string; codeChallenge: string; state?: string; exp: number }
interface Code { agentId: string; clientId: string; redirectUri: string; codeChallenge: string; by: string; exp: number }

// An acceptable return address: https, or http on this computer (locally installed assistants)
const isLoopback = (u: URL) => u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
function validRedirect(uri: unknown): boolean {
  try { const u = new URL(String(uri)); return !u.hash && (u.protocol === 'https:' || isLoopback(u)) } catch { return false }
}
// Exact comparison; for a local address the port may change on every session (RFC 8252)
function sameRedirect(registered: string, given: string): boolean {
  if (registered === given) return true
  try {
    const a = new URL(registered), b = new URL(given)
    return isLoopback(a) && isLoopback(b) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search
  } catch { return false }
}

export interface OAuthOptions {
  issuer: string            // e.g. https://agentpay.pdf-libre.de
  resource: string          // the MCP server address, e.g. https://agentpay.pdf-libre.de/mcp
  path?: string             // storage file
  agentExists: (id: string) => boolean
  agentActive: (id: string) => boolean
  checkAdminPassword: (password: string) => boolean
  onConnect: (g: Grant) => void | Promise<void>
}

export class OAuthServer {
  private s: State
  private pairings = new Map<string, Pairing>() // key: hash of the connection code
  private pending = new Map<string, Pending>()  // sign-in requests shown on screen
  private codes = new Map<string, Code>()       // codes d'autorisation (hash)
  private failures = new Map<string, { n: number; reset: number }>() // failed attempts per IP address
  private path: string

  constructor(private o: OAuthOptions) {
    this.path = o.path ?? 'data/oauth.json'
    this.s = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { clients: [], grants: [], access: [] }
  }

  private save() {
    const now = Date.now()
    this.s.access = this.s.access.filter(a => a.exp > now)
    this.s.grants = this.s.grants.filter(g => g.refreshExp > now)
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.s, null, 2) + '\n')
    renameSync(`${this.path}.tmp`, this.path)
  }

  private sweep() {
    const now = Date.now()
    for (const m of [this.pairings, this.pending, this.codes] as Map<string, { exp: number }>[])
      for (const [k, v] of m) if (v.exp < now) m.delete(k)
  }

  // ---- Used by the proxy ----

  // Access token → agent (or undefined)
  authenticate(authHeader: string | undefined): string | undefined {
    const t = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!t.startsWith('agoa_')) return undefined
    const h = sha256(t)
    const a = this.s.access.find(x => x.hash === h)
    if (!a || a.exp < Date.now()) return undefined
    const g = this.s.grants.find(x => x.id === a.grantId)
    if (!g) return undefined
    // Last-used date: saved at most once a minute
    if (Date.now() - Date.parse(g.lastUsedAt) > 60_000) { g.lastUsedAt = new Date().toISOString(); this.save() }
    return g.agentId
  }

  // Connection code for an agent, created by the administrator (shown only once)
  createPairing(agentId: string, by: string) {
    this.sweep()
    const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' // no 0/O, 1/I/L: easy to read out loud
    const raw = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('')
    const exp = Date.now() + PAIRING_TTL
    this.pairings.set(sha256(raw), { agentId, exp, by })
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: new Date(exp).toISOString() }
  }

  connections() {
    return this.s.grants.map(({ refreshHash, refreshExp, ...g }) => g)
  }

  revoke(grantId: string): Grant | undefined {
    const g = this.s.grants.find(x => x.id === grantId)
    if (!g) return undefined
    this.s.grants = this.s.grants.filter(x => x.id !== grantId)
    this.s.access = this.s.access.filter(a => a.grantId !== grantId)
    this.save()
    return g
  }

  // ---- The OAuth web endpoints ----

  router() {
    const r = express.Router()
    const { issuer, resource } = this.o
    const form = express.urlencoded({ extended: false, limit: '20kb' })

    // Assistants running in a browser read these addresses from another origin
    const cors: express.RequestHandler = (req, res, next) => {
      res.set('Access-Control-Allow-Origin', '*')
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version')
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      if (req.method === 'OPTIONS') return res.sendStatus(204)
      next()
    }

    const resourceMeta = { resource, authorization_servers: [issuer], bearer_methods_supported: ['header'], scopes_supported: ['agent'], resource_name: 'AgentGetPay' }
    r.use(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], cors)
    r.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => res.json(resourceMeta))

    const asMeta = {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['agent']
    }
    r.use(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'], cors)
    r.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration'], (_req, res) => res.json(asMeta))

    // Dynamic registration: the assistant introduces itself (name + return address) and gets an id
    r.use('/register', cors)
    r.post('/register', express.json({ limit: '20kb' }), (req, res) => {
      const uris = req.body?.redirect_uris
      if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(validRedirect)) {
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https URLs, or http URLs on localhost' })
      }
      const client: Client = {
        client_id: `agc_${randomBytes(16).toString('base64url')}`,
        client_name: String(req.body?.client_name ?? 'AI assistant').replace(/[\u0000-\u001f]/g, '').slice(0, 60) || 'AI assistant',
        redirect_uris: uris.map(String),
        created_at: new Date().toISOString()
      }
      this.s.clients.push(client)
      // Limit against mass registration: forget the oldest clients without a connection
      if (this.s.clients.length > MAX_CLIENTS) {
        const used = new Set(this.s.grants.map(g => g.clientId))
        const idx = this.s.clients.findIndex(c => !used.has(c.client_id))
        if (idx >= 0) this.s.clients.splice(idx, 1)
      }
      this.save()
      res.status(201).json({
        ...client, client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code']
      })
    })

    // Sign-in page: never shown inside another site's frame (protection against clickjacking)
    r.use('/authorize', (_req, res, next) => { res.set('X-Frame-Options', 'DENY').set('Content-Security-Policy', "frame-ancestors 'none'").set('Cache-Control', 'no-store'); next() })
    r.get('/authorize', (req, res) => {
      this.sweep()
      const q = req.query as Record<string, string | undefined>
      const client = this.s.clients.find(c => c.client_id === q.client_id)
      const redirect = client && q.redirect_uri && client.redirect_uris.some(u => sameRedirect(u, q.redirect_uri!)) ? q.redirect_uri : undefined
      // Unknown client or return address: NEVER redirect to an unverified address
      if (!client || !redirect) return res.status(400).send(page('Connection refused', `<p>This assistant is not registered, or its return address does not match. Remove the connector and add it again.</p>`))
      const fail = (error: string, description: string) => res.redirect(withParams(redirect, { error, error_description: description, state: q.state, iss: issuer }))
      if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported')
      if (!q.code_challenge || q.code_challenge_method !== 'S256') return fail('invalid_request', 'PKCE with S256 is required')
      if (q.resource && q.resource.replace(/\/$/, '') !== resource) return fail('invalid_target', `This server only issues tokens for ${resource}`)
      const id = randomBytes(18).toString('base64url')
      this.pending.set(id, { clientId: client.client_id, redirectUri: redirect, codeChallenge: q.code_challenge, state: q.state, exp: Date.now() + PENDING_TTL })
      res.send(consentPage(id, client.client_name, new URL(redirect).host))
    })

    r.post('/authorize', form, async (req, res) => {
      this.sweep()
      const b = req.body ?? {}
      const p = this.pending.get(String(b.request_id ?? ''))
      if (!p) return res.status(400).send(page('Request expired', '<p>This page has expired. Go back to your assistant and click <b>Connect</b> again.</p>'))
      const client = this.s.clients.find(c => c.client_id === p.clientId)
      const back = (params: Record<string, string | undefined>) => { this.pending.delete(String(b.request_id)); res.redirect(withParams(p.redirectUri, { ...params, state: p.state, iss: issuer })) }
      if (b.action === 'cancel') return back({ error: 'access_denied', error_description: 'The user cancelled the connection' })

      // Attempt limit: 10 failures per IP address per quarter hour
      const ip = req.ip ?? 'unknown'
      const f = this.failures.get(ip)
      if (f && f.reset > Date.now() && f.n >= 10) return res.status(429).send(page('Too many attempts', '<p>Too many wrong codes. Wait 15 minutes and try again.</p>'))
      const wrong = (msg: string) => {
        const cur = f && f.reset > Date.now() ? f : { n: 0, reset: Date.now() + 15 * 60_000 }
        cur.n++; this.failures.set(ip, cur)
        res.status(400).send(consentPage(String(b.request_id), client?.client_name ?? 'AI assistant', new URL(p.redirectUri).host, msg, b.mode === 'admin'))
      }

      let agentId: string, by: string
      if (b.mode === 'admin') {
        if (!this.o.checkAdminPassword(String(b.password ?? ''))) return wrong('Wrong admin password.')
        agentId = String(b.agent ?? '').trim().toLowerCase()
        if (!this.o.agentExists(agentId)) return wrong(`Unknown agent "${agentId}".`)
        by = String(b.name ?? '').trim().slice(0, 40) || 'admin'
      } else {
        const raw = String(b.code ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '')
        const key = sha256(raw)
        const pairing = this.pairings.get(key)
        if (!pairing || pairing.exp < Date.now()) return wrong('This code is not valid or has expired. Ask your administrator for a new one.')
        this.pairings.delete(key) // usage unique
        agentId = pairing.agentId; by = pairing.by
      }
      if (!this.o.agentActive(agentId)) return wrong(`The agent "${agentId}" is suspended.`)

      this.failures.delete(ip)
      const code = token('agcode')
      this.codes.set(sha256(code), { agentId, clientId: p.clientId, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge, by, exp: Date.now() + CODE_TTL })
      back({ code })
    })

    // Code exchange for tokens, and renewal
    r.use('/token', cors)
    r.post('/token', form, express.json({ limit: '20kb' }), async (req, res) => {
      res.set('Cache-Control', 'no-store')
      const b = req.body ?? {}
      const err = (error: string, description: string, status = 400) => res.status(status).json({ error, error_description: description })

      if (b.grant_type === 'authorization_code') {
        this.sweep()
        const key = sha256(String(b.code ?? ''))
        const c = this.codes.get(key)
        this.codes.delete(key) // single use, even on error
        if (!c || c.exp < Date.now()) return err('invalid_grant', 'Unknown or expired authorization code')
        if (c.clientId !== b.client_id) return err('invalid_grant', 'This code was issued to another client')
        if (b.redirect_uri && !sameRedirect(c.redirectUri, String(b.redirect_uri))) return err('invalid_grant', 'redirect_uri does not match')
        if (!b.code_verifier || b64urlSha256(String(b.code_verifier)) !== c.codeChallenge) return err('invalid_grant', 'PKCE verification failed')
        const client = this.s.clients.find(x => x.client_id === c.clientId)
        const refresh = token('agor')
        const now = new Date().toISOString()
        const g: Grant = {
          id: randomBytes(8).toString('hex'), agentId: c.agentId, clientId: c.clientId, clientName: client?.client_name ?? 'AI assistant',
          createdAt: now, lastUsedAt: now, by: c.by, refreshHash: sha256(refresh), refreshExp: Date.now() + REFRESH_TTL * 1000
        }
        this.s.grants.push(g)
        const access = this.issueAccess(g.id)
        await this.o.onConnect(g)
        return res.json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: 'agent' })
      }

      if (b.grant_type === 'refresh_token') {
        const g = this.s.grants.find(x => x.refreshHash === sha256(String(b.refresh_token ?? '')))
        if (!g || g.refreshExp < Date.now()) return err('invalid_grant', 'Unknown, expired or revoked refresh token')
        if (b.client_id && b.client_id !== g.clientId) return err('invalid_grant', 'This token was issued to another client')
        if (!this.o.agentExists(g.agentId)) return err('invalid_grant', 'The agent no longer exists')
        const refresh = token('agor') // rotation: the old token no longer works
        g.refreshHash = sha256(refresh)
        g.refreshExp = Date.now() + REFRESH_TTL * 1000
        return res.json({ access_token: this.issueAccess(g.id), token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: 'agent' })
      }

      err('unsupported_grant_type', 'Use authorization_code or refresh_token')
    })

    return r
  }

  private issueAccess(grantId: string) {
    const t = token('agoa')
    this.s.access.push({ hash: sha256(t), grantId, exp: Date.now() + ACCESS_TTL * 1000 })
    this.save()
    return t
  }
}

function withParams(base: string, params: Record<string, string | undefined>) {
  const u = new URL(base)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v)
  return u.toString()
}

// ---- HTML pages (no JavaScript, no external resource) ----

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · AgentGetPay</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#16181d; --muted:#6b7280; --line:#e5e7eb; --accent:#2f4fd8; --bad:#b42318; --bad-bg:#fdecea; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#171a21; --text:#eceef2; --muted:#9aa1ad; --line:#262b35; --accent:#8ea2ff; --bad:#ff8a80; --bad-bg:#3a1714; } }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 -apple-system,"Segoe UI",Inter,sans-serif; background:var(--bg); color:var(--text); }
  main { max-width:440px; margin:48px auto; padding:0 16px; }
  .brand { font-weight:650; margin-bottom:16px; } .brand small { display:block; font-weight:400; color:var(--muted); font-size:13px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; }
  h1 { font-size:18px; margin:0 0 6px; } p { color:var(--muted); margin:0 0 14px; font-size:14px; }
  label { display:block; font-size:13px; color:var(--muted); margin-bottom:10px; }
  input { display:block; width:100%; margin-top:4px; font:inherit; padding:9px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); }
  input.code { font-size:20px; letter-spacing:.15em; text-transform:uppercase; text-align:center; }
  .row { display:flex; gap:8px; margin-top:6px; }
  button { font:inherit; font-weight:600; font-size:14px; padding:9px 14px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--text); cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; flex:1; }
  .err { background:var(--bad-bg); color:var(--bad); border-radius:8px; padding:8px 12px; font-size:14px; margin-bottom:14px; }
  details { margin-top:18px; border-top:1px solid var(--line); padding-top:14px; } summary { cursor:pointer; color:var(--accent); font-size:14px; }
  .host { font-weight:600; color:var(--text); }
</style></head><body><main>
<div class="brand">AgentGetPay<small>Spend control for AI agents</small></div>
<div class="card">${body}</div></main></body></html>`
}

function consentPage(id: string, clientName: string, host: string, error = '', adminOpen = false) {
  return page('Connect an assistant', `
  <h1>Connect ${esc(clientName)}</h1>
  <p>The assistant will be able to buy services <b>within the budget and rules of one agent</b>. It never gets access to the company wallet. After connecting you will return to <span class="host">${esc(host)}</span>.</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <form method="post" action="/authorize">
    <input type="hidden" name="request_id" value="${esc(id)}"><input type="hidden" name="mode" value="code">
    <label>Connection code from your administrator<input class="code" name="code" placeholder="ABCD-EFGH" autocomplete="one-time-code" ${adminOpen ? '' : 'autofocus'}></label>
    <div class="row"><button class="primary" type="submit">Connect</button><button type="submit" name="action" value="cancel" formnovalidate>Cancel</button></div>
  </form>
  <details ${adminOpen ? 'open' : ''}><summary>I am the administrator</summary>
    <form method="post" action="/authorize" style="margin-top:12px">
      <input type="hidden" name="request_id" value="${esc(id)}"><input type="hidden" name="mode" value="admin">
      <label>Your name (shown in the audit log)<input name="name" autocomplete="name"></label>
      <label>Admin password<input name="password" type="password" autocomplete="current-password" ${adminOpen ? 'autofocus' : ''}></label>
      <label>Agent<input name="agent" placeholder="docs-01" autocapitalize="off"></label>
      <div class="row"><button class="primary" type="submit">Connect as this agent</button></div>
    </form>
  </details>`)
}
