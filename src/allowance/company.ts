// The COMPANY's side of the allowance, run with the company's BRC-100 wallet: BSV Desktop in the
// admin page (new WalletClient('auto')), or a wallet-toolbox wallet in the offline tests (same
// WalletInterface). The company's keys never leave its wallet.
import { Transaction, Utils, type WalletInterface } from '../shared/bsv.js'
import { AllowanceScript, RECLAIM_UNLOCK_LENGTH, walletPubKey, walletSigner } from './script.js'

// The proxy's admin API (/v1/admin/allowances/...), with the admin password already attached
export type AdminApi = (path: string, method?: string, body?: unknown) => Promise<any>

// Locks `satoshis` of the company's money in the agent's allowance and hands the proof to the proxy
export async function fundAllowance(wallet: WalletInterface, api: AdminApi, agentId: string, satoshis: number) {
  if (!Number.isSafeInteger(satoshis) || satoshis < 1000) throw new Error('Fund at least 1000 sats')
  const k = await api(`/allowances/${agentId}/keys`)
  const companyPub = await walletPubKey(wallet, k.companyKeyID) // a DERIVED key, never the identity key
  const lockingScript = new AllowanceScript().lock({ agentPub: k.agentPub, policyPub: k.policyPub, companyPub }).toHex()
  const res = await wallet.createAction({
    description: `Allowance for agent ${agentId}`.slice(0, 50),
    outputs: [{ lockingScript, satoshis, outputDescription: 'Agent allowance' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  if (!res.tx) throw new Error('The wallet did not return the transaction')
  const outputIndex = Transaction.fromAtomicBEEF(res.tx).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript) // by script, never 0
  if (outputIndex < 0) throw new Error('Allowance output not found in the transaction')
  return api(`/allowances/${agentId}/fund`, 'POST', { beef: Array.from(res.tx), outputIndex, companyPub })
}

// Spends every UTXO of the allowance back to the company's own wallet, then tells the proxy
export async function reclaimAllowance(wallet: WalletInterface, api: AdminApi, agentId: string) {
  const v = await api(`/allowances/${agentId}`)
  if (v.status !== 'open' || !v.utxos?.length || !v.beef) throw new Error('This agent has no open allowance')
  const created = await wallet.createAction({
    description: `Reclaim allowance of ${agentId}`.slice(0, 50),
    inputBEEF: Utils.toArray(v.beef, 'hex'),
    inputs: v.utxos.map((u: { txid: string; vout: number }) => ({ outpoint: `${u.txid}.${u.vout}`, unlockingScriptLength: RECLAIM_UNLOCK_LENGTH, inputDescription: 'Agent allowance' })),
    outputs: [], // everything goes to the wallet's change: back into the company's balance
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  const signable = created.signableTransaction
  if (!signable) throw new Error('The wallet did not return a transaction to sign')
  const tx = Transaction.fromAtomicBEEF(signable.tx)
  const unlock = new AllowanceScript().unlockReclaim(walletSigner(wallet, v.companyKeyID))
  const ours = new Set(v.utxos.map((u: { txid: string; vout: number }) => `${u.txid}.${u.vout}`))
  const spends: Record<number, { unlockingScript: string }> = {}
  for (let i = 0; i < tx.inputs.length; i++) {
    const inp = tx.inputs[i]
    if (ours.has(`${inp.sourceTXID ?? inp.sourceTransaction?.id('hex')}.${inp.sourceOutputIndex}`)) spends[i] = { unlockingScript: (await unlock.sign(tx, i)).toHex() }
  }
  const signed = await wallet.signAction({ reference: signable.reference, spends, options: { acceptDelayedBroadcast: false } })
  if (!signed.tx) throw new Error('The wallet did not return the signed transaction')
  return api(`/allowances/${agentId}/reclaim`, 'POST', { beef: Array.from(signed.tx) })
}
