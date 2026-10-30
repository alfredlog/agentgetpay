// The AGENT's side in the test runners: its wallets live in their own temporary folder, outside the
// proxy's working folder (the proxy process must hold no agent key), and every proxy call goes through
// the agent's client, which completes the payment steps (co-sign the top-up, pay, internalize refunds).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAgentWallets } from '../../allowance/agent-signer.js'
import { createProxyClient, type ProxyClient, type ProxyClientOptions } from '../../agent/proxy-client.js'

export const agentSideDir = mkdtempSync(join(tmpdir(), 'agentgetpay-agent-side-'))
process.on('exit', () => rmSync(agentSideDir, { recursive: true, force: true }))
export const agentWallets = new LocalAgentWallets(join(agentSideDir, 'agents'))

const clients = new Map<string, ProxyClient>()
export function agentClient(proxy: string, apiKey: string, extra: Partial<ProxyClientOptions> = {}): ProxyClient {
  if (Object.keys(extra).length) return createProxyClient({ proxy, apiKey, wallets: agentWallets, ...extra })
  let c = clients.get(`${proxy} ${apiKey}`)
  if (!c) { c = createProxyClient({ proxy, apiKey, wallets: agentWallets }); clients.set(`${proxy} ${apiKey}`, c) }
  return c
}

// A proxy call made by the agent (its MCP server would do the same), as a plain Response
export const agentFetch = (proxy: string, apiKey: string, path: string, method = 'GET', body?: unknown) =>
  agentClient(proxy, apiKey).call(path, method, body as Record<string, unknown> | undefined)

// The agent registers its public keys (its MCP server does it on first start): before the company funds it
export const registerTestAgent = (proxy: string, apiKey: string) => agentClient(proxy, apiKey).register()
