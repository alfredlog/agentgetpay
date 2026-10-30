// Admin page: the company funds and reclaims agent allowances with its own wallet, BSV Desktop
// (BRC-100, new WalletClient('auto')). The keys never leave BSV Desktop; the page only builds the
// locking script, asks the wallet to create / sign the transactions and hands the proofs to the proxy.
// Bundled by scripts/build-web.mjs into public/allowance.js.
import { WalletClient } from './bsv-browser.js'
import { fundAllowance, reclaimAllowance, type AdminApi } from '../allowance/company.js'

let wallet: WalletClient | undefined
const connect = async () => {
  wallet ??= new WalletClient('auto')
  await wallet.waitForAuthentication({}) // resolves once BSV Desktop is open and unlocked
  return wallet
}

declare global { interface Window { agpAllowance: unknown } }
window.agpAllowance = {
  fund: async (api: AdminApi, agentId: string, sats: number) => fundAllowance(await connect(), api, agentId, sats),
  reclaim: async (api: AdminApi, agentId: string) => reclaimAllowance(await connect(), api, agentId)
}
