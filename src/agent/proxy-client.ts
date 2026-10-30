// The AGENT's client for the payment proxy (used by the MCP server, the demo agents and the tests).
// It holds the agent's own wallet (LocalAgentWallets) and completes the steps the proxy asks for during
// a purchase, then resubmits them (POST /v1/steps/:stepId):
//
//   cosign-topup  check the top-up transaction (cosignTopup) and return the agent's signatures
//   pay           internalize the top-up (SPV first), build the BRC-121 headers with constructPaymentHeaders
//   refund        internalize the merchant's BRC-29 refund
//
// Every answer repeats the url and the amount of the step, so the proxy can refuse an answer meant for
// another purchase. The caller sees an ordinary proxy answer (the merchant's response, a refusal…).
import type { ChainTracker } from '../shared/bsv.js'
import { constructPaymentHeaders, withHostOriginator } from '../shared/brc121.js'
import { acceptBrc29Payment, isBrc29Payment } from '../shared/payments.js'
import { openChainTracker, spendableSats } from '../shared/wallet.js'
import { agentRegistration, cosignTopup, LocalAgentWallets, type AgentSigner } from '../allowance/agent-signer.js'

export interface ProxyClientOptions {
  proxy: string
  apiKey: string
  wallets?: LocalAgentWallets
  chainTracker?: () => Promise<ChainTracker>
  // For tests: completes a step in place of the honest client (`complete` is the honest completion)
  tamper?: (step: any, complete: (step: any) => Promise<any>) => Promise<unknown>
}

export function createProxyClient(o: ProxyClientOptions) {
  const base = o.proxy.replace(/\/$/, '')
  const wallets = o.wallets ?? new LocalAgentWallets()
  const tracker = o.chainTracker ?? openChainTracker
  let agentId: Promise<string> | undefined
  let registered: Promise<void> | undefined

  const send = (path: string, method: string, body?: unknown) => fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${o.apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })

  // The agent this API key belongs to (asked once)
  const id = () => {
    agentId ??= send('/v1/me', 'GET').then(async r => {
      const me = await r.json().catch(() => ({})) as { agentId?: string; error?: string }
      if (!r.ok || !me.agentId) throw new Error(`Cannot identify the agent: ${me.error ?? r.status}`)
      return me.agentId
    })
    agentId.catch(() => { agentId = undefined })
    return agentId
  }
  const signer = async (): Promise<AgentSigner> => wallets.get(await id())

  // Registers the agent's public keys with the proxy (idempotent). Needed before the company can fund it.
  const register = () => {
    registered ??= (async () => {
      const r = await send('/v1/agent/keys', 'POST', await agentRegistration(await signer()))
      if (!r.ok) throw new Error(`Key registration refused: ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.status}`)
    })()
    registered.catch(() => { registered = undefined })
    return registered
  }

  // Completes one step with the agent's own wallet
  async function complete(step: any, expectedUrl?: string): Promise<unknown> {
    const s = await signer()
    const wallet = await s.wallet()
    if (expectedUrl !== undefined && step.url !== expectedUrl) throw new Error('the proxy asked about another purchase')
    switch (step.step) {
      case 'cosign-topup':
        return { url: step.url, sats: step.sats, signatures: await cosignTopup(s, step) }
      case 'pay': {
        if (step.topup !== undefined) {
          if (!isBrc29Payment(step.topup)) throw new Error('malformed top-up')
          await acceptBrc29Payment(wallet, step.topup, await tracker(), 'Allowance top-up')
        }
        const headers = await constructPaymentHeaders(withHostOriginator(wallet), step.url, step.sats, step.server)
        return { url: step.url, sats: step.sats, headers }
      }
      case 'refund': {
        if (!isBrc29Payment(step.refund)) throw new Error('malformed refund')
        await acceptBrc29Payment(wallet, step.refund, undefined, `Refund of ${String(step.paymentTxid).slice(0, 16)}`)
        return { url: step.url, ok: true, txid: step.refund.txid }
      }
      default: throw new Error(`unknown step ${String(step.step)}`)
    }
  }

  // A proxy call. For a purchase (/v1/fetch, /v1/requests/:id/execute) it adds what the wallet holds,
  // then completes every step until the proxy gives its final answer.
  async function call(path: string, method = 'GET', body?: Record<string, unknown>): Promise<Response> {
    const purchase = method === 'POST' && ((path === '/v1/fetch' && !body?.dryRun) || /^\/v1\/requests\/[^/]+\/execute$/.test(path))
    if (purchase) {
      await register()
      body = { ...body, walletSats: await spendableSats(await (await signer()).wallet()) }
    }
    let res = await send(path, method, body)
    const url = typeof body?.url === 'string' ? body.url : undefined
    while (res.headers.get('X-AgentGetPay-Step')) {
      const step = await res.json() as any
      let answer: unknown
      try { answer = o.tamper ? await o.tamper(step, x => complete(x, url)) : await complete(step, url) } catch (e) { answer = { error: (e as Error).message } }
      res = await send(`/v1/steps/${encodeURIComponent(step.stepId)}`, 'POST', answer)
    }
    return res
  }

  return { call, register, agentId: id, signer }
}
export type ProxyClient = ReturnType<typeof createProxyClient>
