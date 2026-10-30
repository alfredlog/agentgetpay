// The company, in the test runners: a wallet-toolbox wallet on the shared mock chain stands in for
// BSV Desktop and funds agent allowances through the proxy's admin API, exactly as the admin page does.
import type { WalletInterface } from '../../shared/bsv.js'
import { fundAllowance, reclaimAllowance, type AdminApi } from '../../allowance/company.js'
import { openMockChain } from './mockchain.js'

let wallet: Promise<WalletInterface> | undefined
export function companyWallet(): Promise<WalletInterface> {
  wallet ??= (async () => {
    const chain = await openMockChain(process.env.MOCK_CHAIN_DB!)
    const w = await chain.makeWallet()
    await chain.fund(w, 20_000_000)
    return w
  })()
  return wallet
}

export const adminApi = (proxy: string, adminToken: string): AdminApi => async (path, method = 'GET', body) => {
  const res = await fetch(`${proxy}/v1/admin${path}`, {
    method, headers: { 'X-Admin-Token': adminToken, 'X-Admin-Name': 'Test company', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const data = await res.json().catch(() => ({})) as any
  if (!res.ok) throw new Error(data.error ?? `Admin API ${res.status}`)
  return data
}

export const fundTestAllowance = async (proxy: string, adminToken: string, agentId: string, sats = 2_000_000) =>
  fundAllowance(await companyWallet(), adminApi(proxy, adminToken), agentId, sats)
export const reclaimTestAllowance = async (proxy: string, adminToken: string, agentId: string) =>
  reclaimAllowance(await companyWallet(), adminApi(proxy, adminToken), agentId)
