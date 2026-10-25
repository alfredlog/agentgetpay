// Test of the OAuth sign-in with the REAL official MCP client (the one AI assistants use).
// Starts a proxy and an MCP server in a temporary folder (your log and config are not touched).
// No payment: checks the sign-in, the agent identity, the renewal and the disconnection.
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { PrivateKey } from '@bsv/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'

const PROXY_PORT = 5150, MCP_PORT = 5170
const PROXY = `http://127.0.0.1:${PROXY_PORT}`, MCP = `http://127.0.0.1:${MCP_PORT}/mcp`
const ADMIN = 'test-admin-password-123'
const root = resolve('.')
const dir = mkdtempSync(join(tmpdir(), 'agentgetpay-oauth-'))
cpSync(join(root, 'config'), join(dir, 'config'), { recursive: true })
writeFileSync(join(dir, '.env'), `BSV_WIF=${PrivateKey.fromRandom().toWif()}\nADMIN_TOKEN=${ADMIN}\n`)

const tsx = createRequire(import.meta.url).resolve('tsx/cli')
const procs: ChildProcess[] = []
const start = (file: string, env: Record<string, string>) => {
  const p = spawn(process.execPath, [tsx, join(root, file)], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
  p.stderr!.on('data', d => { if (/error/i.test(String(d))) process.stderr.write(d) })
  procs.push(p)
}
start('src/proxy/server.ts', { PROXY_PORT: String(PROXY_PORT), MCP_PORT: String(MCP_PORT), TELEGRAM_BOT_TOKEN: '', APPROVAL_AUTO: 'rejected' })
start('src/mcp/server.ts', { MCP_TRANSPORT: 'http', MCP_PORT: String(MCP_PORT), AGENTGETPAY_URL: PROXY, MCP_WORKSPACE: join(dir, 'workspace') })

let failures = 0
const check = (ok: boolean, label: string) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) failures++ }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const admin = (path: string, method = 'GET') => fetch(`${PROXY}/v1/admin${path}`, { method, headers: { 'X-Admin-Token': ADMIN, 'X-Admin-Name': 'Test admin' } }).then(r => r.json())

try {
  for (let i = 0; i < 60; i++) { if (await fetch(`${PROXY}/v1/stats`).then(() => fetch(MCP, { method: 'POST' })).then(() => true, () => false)) break; await sleep(250) }

  // 1. Without a token: 401 + sign-in address
  const r401 = await fetch(MCP, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  check(r401.status === 401 && /resource_metadata=/.test(r401.headers.get('WWW-Authenticate') ?? ''), 'MCP server asks to sign in (401 + resource_metadata)')

  // 2. The administrator creates a connection code for docs-01
  const pairing = await admin('/agents/docs-01/pairing', 'POST')
  check(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pairing.code), `Admin issued a connection code (${pairing.code})`)

  // 3. The official MCP client signs in with OAuth; we play the employee typing the code
  let authCode = ''
  const store: Record<string, any> = {}
  const provider: OAuthClientProvider = {
    get redirectUrl() { return 'http://localhost:9999/callback' },
    get clientMetadata() { return { client_name: 'Test assistant', redirect_uris: ['http://localhost:9999/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } },
    clientInformation: () => store.client,
    saveClientInformation: c => { store.client = c },
    tokens: () => store.tokens,
    saveTokens: t => { store.tokens = t },
    saveCodeVerifier: v => { store.verifier = v },
    codeVerifier: () => store.verifier,
    redirectToAuthorization: async (url: URL) => {
      const html = await fetch(url).then(r => r.text())
      const requestId = html.match(/name="request_id" value="([^"]+)"/)?.[1] ?? ''
      const post = (body: Record<string, string>) => fetch(`${PROXY}/authorize`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ request_id: requestId, ...body }) })
      const bad = await post({ mode: 'code', code: 'AAAA-AAAA' })
      check(bad.status === 400 && /not valid/.test(await bad.text()), 'Wrong connection code is refused')
      const ok = await post({ mode: 'code', code: pairing.code.toLowerCase() })
      const loc = new URL(ok.headers.get('Location') ?? 'http://x/')
      authCode = loc.searchParams.get('code') ?? ''
      check(ok.status === 302 && !!authCode && loc.searchParams.get('iss') === PROXY, 'Correct code → back to the assistant with an authorization code')
      const again = await post({ mode: 'code', code: pairing.code })
      check(again.status === 400, 'The same page cannot be used twice')
    }
  }

  const connect = async () => {
    const client = new Client({ name: 'oauth-test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider }))
    return client
  }
  try { await connect(); check(false, 'Connection without sign-in should fail') }
  catch (e) { check(e instanceof UnauthorizedError, 'Client was sent to the sign-in page') }

  const t = new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider })
  await t.finishAuth(authCode)
  check(!!store.tokens?.access_token?.startsWith('agoa_') && !!store.tokens?.refresh_token, 'Tokens received (PKCE verified)')

  // 4. The assistant acts as docs-01
  let client = await connect()
  const budget = await client.callTool({ name: 'check_budget', arguments: {} }) as any
  const text = budget.content?.[0]?.text ?? ''
  check(/docs-01/.test(text), 'Assistant acts as agent docs-01 (check_budget)')
  await client.close()

  const conns = await admin('/connections')
  check(conns.length === 1 && conns[0].agentId === 'docs-01' && conns[0].clientName === 'Test assistant', 'Admin sees the connected assistant')
  const ledger = await fetch(`${PROXY}/v1/ledger`).then(r => r.json())
  check(ledger.some((e: any) => e.reason === 'Assistant connected: Test assistant' && e.approvedBy === 'Test admin'), 'Connection recorded in the audit log')

  // 5. Renewal: the old refresh token no longer works
  const oldRefresh = store.tokens.refresh_token
  const refresh = (rt: string) => fetch(`${PROXY}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: store.client.client_id }) })
  const r1 = await refresh(oldRefresh)
  const fresh = await r1.json()
  check(r1.ok && fresh.access_token && fresh.refresh_token !== oldRefresh, 'Refresh gives new tokens')
  check((await refresh(oldRefresh)).status === 400, 'Old refresh token is rejected (rotation)')
  store.tokens = fresh

  // 6. Disconnection by the administrator
  await admin(`/connections/${conns[0].id}`, 'DELETE')
  const me = await fetch(`${PROXY}/v1/me`, { headers: { Authorization: `Bearer ${fresh.access_token}` } })
  check(me.status === 401, 'After "Disconnect", the token no longer works')
  check((await refresh(fresh.refresh_token)).status === 400, 'After "Disconnect", the refresh token no longer works')

  // 7. Trop d'essais : blocage
  const html = await fetch(`${PROXY}/authorize?` + new URLSearchParams({ response_type: 'code', client_id: store.client.client_id, redirect_uri: 'http://localhost:9999/callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })).then(r => r.text())
  const id = html.match(/name="request_id" value="([^"]+)"/)?.[1] ?? ''
  let last = 0
  for (let i = 0; i < 11; i++) last = (await fetch(`${PROXY}/authorize`, { method: 'POST', body: new URLSearchParams({ request_id: id, mode: 'code', code: `ZZZZ-ZZZ${i}` }) })).status
  check(last === 429, 'Guessing codes is blocked after 10 attempts')

  // 8. An unregistered return address is never used
  const evil = await fetch(`${PROXY}/authorize?` + new URLSearchParams({ response_type: 'code', client_id: store.client.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' }), { redirect: 'manual' })
  check(evil.status === 400, 'Unregistered return address is refused (no redirect)')
} catch (e) {
  console.error(e); failures++
} finally {
  for (const p of procs) p.kill()
  rmSync(dir, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll OAuth checks passed')
process.exit(failures ? 1 : 0)
