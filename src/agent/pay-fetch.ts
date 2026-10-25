// The AGENT side: a fetch() that can pay a 402 response automatically.
// In step 3 this code becomes the payment proxy, with the rules engine plugged into `beforePay`.
import { Transaction, P2PKH, LockingScript } from '@bsv/sdk'
import { NETWORK, PaymentRequired, PaymentPayload, PaymentResponse, OrderInfo, encode, decode } from '../shared/x402.js'
import { UtxoProvider } from '../shared/utxo.js'
import { Mutex } from '../shared/mutex.js'

export type Unlocker = ReturnType<P2PKH['unlock']>

export interface PayFetchOptions {
  address: string          // testnet address of the payer
  unlocker: () => Unlocker // signs the inputs; the key stays in the KeyStore
  utxos: UtxoProvider
  maxSats?: number // simple safeguard, replaced by the rules engine in step 3
  beforePay?: (offer: { url: string; amount: number; payTo: string; order?: OrderInfo }) => Promise<boolean>
  spendLock?: Mutex                // only one payment at a time spends the wallet
  onSpent?: (tx: Transaction) => void // called inside the lock once the seller has accepted
}

export interface PayFetchResult {
  response: Response
  paid?: { amount: number; txid: string; tx: Transaction }
}

// Order description sent by the merchant: only a valid, reasonably sized shape is kept
export function validOrder(o: unknown): OrderInfo | undefined {
  const x = o as OrderInfo | undefined
  if (!x || typeof x !== 'object' || typeof x.merchant !== 'string' || typeof x.category !== 'string' || !Array.isArray(x.items)) return undefined
  if (x.items.length > 100) return undefined
  const items = x.items.map(i => ({
    name: String(i?.name ?? '').slice(0, 120), quantity: Number(i?.quantity), unitPriceSats: Number(i?.unitPriceSats),
    ...(i?.unit ? { unit: String(i.unit).slice(0, 20) } : {})
  }))
  if (items.some(i => !Number.isInteger(i.quantity) || i.quantity < 1 || !Number.isInteger(i.unitPriceSats) || i.unitPriceSats < 0)) return undefined
  const s = x.shipTo
  const shipTo = s && typeof s === 'object'
    ? { ...(s.name ? { name: String(s.name).slice(0, 80) } : {}), street: String(s.street ?? '').slice(0, 120), postalCode: String(s.postalCode ?? '').slice(0, 12), city: String(s.city ?? '').slice(0, 80), country: String(s.country ?? '').slice(0, 2).toUpperCase() }
    : undefined
  return { merchant: x.merchant.slice(0, 80), category: x.category.toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 60), items, ...(shipTo ? { shipTo } : {}) }
}

export async function payFetch(url: string, init: RequestInit, opts: PayFetchOptions): Promise<PayFetchResult> {
  // 1. First attempt, without paying
  const first = await fetch(url, init)
  if (first.status !== 402) return { response: first }

  // 2. Read the payment offer
  const header = first.headers.get('PAYMENT-REQUIRED')
  if (!header) throw new Error('402 without PAYMENT-REQUIRED header')
  const offer = decode<PaymentRequired>(header)
  const req = offer.accepts.find(a =>
    a.scheme === 'exact' && a.network === NETWORK && a.extra.payloadFormat.kind === 'p2pkh-rawtx')
  if (!req) throw new Error('No compatible offer (BSV testnet, P2PKH)')

  const amount = Number(req.amount)
  if (opts.maxSats !== undefined && amount > opts.maxSats) {
    throw new Error(`Price ${amount} sats > limit ${opts.maxSats} sats: payment refused`)
  }
  if (opts.beforePay && !(await opts.beforePay({ url, amount, payTo: req.payTo, order: validOrder(offer.extensions?.order) }))) {
    throw new Error('Payment refused by beforePay rule')
  }

  const spend = async () => {
    // 3. Build and sign the transaction (without broadcasting it: the seller broadcasts)
    const myAddress = opts.address
    const utxo = await opts.utxos.findUtxo(myAddress, amount + 50)
    if (!utxo) throw new Error('Not enough funds in the agent wallet')

    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: utxo.sourceTransaction,
      sourceOutputIndex: utxo.outputIndex,
      unlockingScriptTemplate: opts.unlocker()
    })
    tx.addOutput({ lockingScript: LockingScript.fromHex(req.extra.lockingScriptHex), satoshis: amount })
    tx.addOutput({ lockingScript: new P2PKH().lock(myAddress), change: true })
    await tx.fee()
    await tx.sign()

    // 4. Send the same request again with the proof of payment
    const payment: PaymentPayload = {
      x402Version: 2,
      accepted: req,
      payload: { lockingScriptHex: req.extra.lockingScriptHex, rawtx: tx.toHex() },
      extensions: { refundTo: myAddress } // if the order is cancelled, the seller refunds here
    }
    const headers = new Headers(init.headers)
    headers.set('PAYMENT-SIGNATURE', encode(payment))
    const second = await fetch(url, { ...init, headers })

    const receiptHeader = second.headers.get('PAYMENT-RESPONSE')
    const receipt = receiptHeader ? decode<PaymentResponse>(receiptHeader) : undefined
    if (!second.ok || !receipt?.success) {
      // No payment receipt: the service refused the work (invalid file…),
      // the transaction was not broadcast, so nothing was paid.
      if (!receipt) {
        const detail = await second.text().then(t => { try { return JSON.parse(t).error ?? t } catch { return t } })
        throw new Error(`Service error ${second.status}: ${String(detail).slice(0, 120)} (not charged)`)
      }
      throw new Error(`Payment rejected by seller: ${receipt.errorReason ?? second.status}`)
    }
    opts.onSpent?.(tx)
    return { response: second, paid: { amount, txid: receipt.transaction!, tx } }
  }
  return opts.spendLock ? opts.spendLock.run(spend) : spend()
}
