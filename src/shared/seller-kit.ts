// Seller kit: lets AI agents pay for any Express route, via HTTP 402 (x402 / BRC-166, BSV).
//
//   const seller = createSeller({ secret: process.env.SELLER_SECRET! })
//   app.get('/api/report', seller.requirePayment(30, 'Full report'), (req, res) => res.json({ ... }))
//
// The price can also be computed from the request, with the order description
// (merchant, category, items, delivery): the buyer can then apply its purchase policy.
//
// Each invoice has its own address, derived from the seller's secret: the key can be recovered later
// (for example to refund) without storing anything but this secret.
import type { Request, Response, NextFunction } from 'express'
import { randomBytes } from 'node:crypto'
import { PrivateKey, Hash, Utils, P2PKH, Transaction, LockingScript } from './bsv.js'
import {
  PaymentRequired, PaymentRequirements, PaymentPayload, PaymentResponse, OrderInfo, RefundNotice, encode, decode
} from './x402.js'
import { ArcadeBroadcaster } from './arcade.js'
import { addressNetwork, x402Network } from './network.js'

export interface Invoice {
  id: string
  resource: string // "POST /api/hotel/book"
  amount: number
  lockingScriptHex: string
  payTo: string
  expiresAt: Date
  settledTxid?: string
  order?: string // invoiced order (JSON): the paid request must describe exactly the same one
  rawtx?: string           // the payment transaction (to be able to refund)
  refundScriptHex?: string // where to refund: the address given by the payer, otherwise their change
}

// What to keep from a paid invoice to refund it later (even after a restart)
export type PaidInvoice = Pick<Invoice, 'id' | 'amount' | 'lockingScriptHex'> & { settledTxid: string; rawtx: string; refundScriptHex: string }

// Fixed price, or price computed from the request with the order description
export type Pricing = number | ((req: Request) => { amount: number; order?: OrderInfo } | { error: string })

export interface SellerOptions {
  secret: string
  skipBroadcast?: boolean // for testing without the network
  invoiceMinutes?: number
  // Called when an invoice is paid (seller's log, "recent orders" page…)
  onPaid?: (inv: Invoice, txid: string, req: Request) => void
  log?: (msg: string) => void
}

export function createSeller(o: SellerOptions) {
  if (!o.secret) throw new Error('Seller secret missing')
  const invoices = new Map<string, Invoice>()      // by lockingScriptHex
  const locks = new Map<string, Promise<void>>()   // one payment at a time per invoice
  const log = o.log ?? ((m: string) => console.log(m))

  // The private key of an invoice (for a refund, for example)
  const invoiceKey = (id: string) => new PrivateKey(Hash.sha256(Utils.toArray(`${o.secret}:${id}`, 'utf8')))

  function createInvoice(resource: string, amount: number, order?: OrderInfo): Invoice {
    const id = randomBytes(12).toString('hex')
    const payTo = invoiceKey(id).toAddress(addressNetwork())
    const lockingScriptHex = new P2PKH().lock(payTo).toHex().toLowerCase()
    const inv: Invoice = {
      id, resource, amount, payTo, lockingScriptHex,
      expiresAt: new Date(Date.now() + (o.invoiceMinutes ?? 15) * 60_000), order: order ? JSON.stringify(order) : undefined
    }
    invoices.set(lockingScriptHex, inv)
    // Housekeeping: forget expired invoices that were never paid
    if (invoices.size > 5000) for (const [k, v] of invoices) if (!v.settledTxid && v.expiresAt < new Date()) invoices.delete(k)
    return inv
  }

  function requirements(inv: Invoice): PaymentRequirements {
    return {
      scheme: 'exact', network: x402Network(), amount: String(inv.amount), asset: 'BSV',
      payTo: inv.payTo, maxTimeoutSeconds: 900,
      extra: {
        chain: 'bsv', unit: 'satoshi', invoiceId: inv.id, lockingScriptHex: inv.lockingScriptHex,
        expiresAt: inv.expiresAt.toISOString(), payloadFormat: { kind: 'p2pkh-rawtx' }
      }
    }
  }

  function fail(res: Response, status: number, reason: string, extra: object = {}) {
    const pr: PaymentResponse = { success: false, network: x402Network(), errorReason: reason }
    res.status(status).set('PAYMENT-RESPONSE', encode(pr)).json({ error: reason, ...extra })
  }

  // Middleware: protects a route with a price
  function requirePayment(pricing: Pricing, description: string) {
    return async (req: Request, res: Response, next: NextFunction) => {
      const resource = `${req.method} ${req.path}`
      const header = req.get('PAYMENT-SIGNATURE')
      const priced = typeof pricing === 'number' ? { amount: pricing, order: undefined } : pricing(req)
      if ('error' in priced) return void res.status(400).json({ error: priced.error })
      const { amount, order } = priced

      // 1. No payment → 402 with a new invoice (and the order description)
      if (!header) {
        const inv = createInvoice(resource, amount, order)
        const body: PaymentRequired = {
          x402Version: 2,
          resource: { url: req.originalUrl, method: req.method, description },
          accepts: [requirements(inv)],
          ...(order ? { extensions: { order } } : {})
        }
        return void res.status(402).set('PAYMENT-REQUIRED', encode(body)).json(body)
      }

      // 2. Read the payment
      let p: PaymentPayload
      try { p = decode<PaymentPayload>(header) } catch { return fail(res, 400, 'malformed_payment') }
      const script = (p.payload?.lockingScriptHex ?? p.accepted?.extra?.lockingScriptHex ?? '').toLowerCase()
      if (p.accepted?.scheme !== 'exact' || !script || !p.payload?.rawtx) return fail(res, 400, 'malformed_payment')

      const inv = invoices.get(script)
      if (!inv) return fail(res, 402, 'invoice_not_found')
      if (inv.resource !== resource) return fail(res, 402, 'resource_mismatch')
      // You cannot pay for one order and receive another (more expensive, other address…)
      if (inv.order !== (order ? JSON.stringify(order) : undefined)) return fail(res, 402, 'order_mismatch')

      // Only one processing at a time for the same invoice
      const previous = locks.get(inv.id) ?? Promise.resolve()
      let release!: () => void
      locks.set(inv.id, new Promise<void>(r => (release = r)))
      await previous
      try {
        if (inv.settledTxid) return serve(inv.settledTxid, false) // already paid: serve again without charging
        if (inv.expiresAt < new Date()) return fail(res, 402, 'invoice_expired')

        // 3. Check the amount paid to the invoice address
        let tx: Transaction
        try { tx = Transaction.fromHex(p.payload.rawtx) } catch { return fail(res, 400, 'malformed_payment') }
        const paid = tx.outputs
          .filter(out => out.lockingScript.toHex().toLowerCase() === script)
          .reduce((s, out) => s + (out.satoshis ?? 0), 0)
        if (paid < inv.amount) return fail(res, 402, 'insufficient_funds', { required: inv.amount, paid })

        // 4. Broadcast the transaction to the network (the seller broadcasts)
        const txid = tx.id('hex')
        if (!o.skipBroadcast) {
          const r = await tx.broadcast(new ArcadeBroadcaster())
          const known = r.status !== 'success' && /already|known|txn-already/i.test(JSON.stringify(r))
          if (r.status !== 'success' && !known) return fail(res, 402, 'broadcast_rejected', { retryable: false, detail: r })
        }

        // 5. Invoice settled → serve the resource. Keep what is needed to refund.
        inv.settledTxid = txid
        inv.rawtx = p.payload.rawtx
        try {
          const to = p.extensions?.refundTo
          inv.refundScriptHex = to ? new P2PKH().lock(to).toHex()
            : tx.outputs.find(out => out.lockingScript.toHex().toLowerCase() !== script)?.lockingScript.toHex() // the payer's change
        } catch { inv.refundScriptHex = undefined }
        log(`Paid: ${inv.amount} sats for ${resource} — tx ${txid}`)
        serve(txid, true)
      } finally {
        release()
        locks.delete(inv.id)
      }

      function serve(txid: string, fresh: boolean) {
        const pr: PaymentResponse = { success: true, transaction: txid, network: x402Network(), extensions: { status: 'mempool' } }
        res.set('PAYMENT-RESPONSE', encode(pr))
        res.locals.payment = { invoice: inv!, txid, replay: !fresh }
        if (fresh) o.onPaid?.(inv!, txid, req)
        next()
      }
    }
  }

  // Refunds a paid invoice: sends the money back to the payer (minus network fees, and minus keepSats
  // if the seller keeps a cancellation fee). The result goes in the PAYMENT-REFUND header of the response.
  async function refund(inv: PaidInvoice, keepSats = 0): Promise<RefundNotice> {
    const paidTx = Transaction.fromHex(inv.rawtx)
    const index = paidTx.outputs.findIndex(out => out.lockingScript.toHex().toLowerCase() === inv.lockingScriptHex)
    if (index < 0) throw new Error('Payment output not found')
    const value = paidTx.outputs[index].satoshis ?? 0
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: paidTx, sourceOutputIndex: index, unlockingScriptTemplate: new P2PKH().unlock(invoiceKey(inv.id)) })
    if (keepSats > 0) tx.addOutput({ lockingScript: new P2PKH().lock(invoiceKey(inv.id).toAddress(addressNetwork())), satoshis: Math.min(keepSats, value) })
    tx.addOutput({ lockingScript: LockingScript.fromHex(inv.refundScriptHex), change: true })
    await tx.fee()
    const back = tx.outputs.at(-1)?.satoshis ?? 0
    if (back < 1) throw new Error('Amount too small to refund after network fees')
    await tx.sign()
    if (!o.skipBroadcast) {
      const r = await tx.broadcast(new ArcadeBroadcaster())
      if (r.status !== 'success' && !/already|known|txn-already/i.test(JSON.stringify(r))) throw new Error(`Refund rejected by the network: ${JSON.stringify(r).slice(0, 200)}`)
    }
    const notice = { paymentTxid: inv.settledTxid, refundTxid: tx.id('hex'), rawtx: tx.toHex(), sats: back }
    log(`Refunded ${back} sats for ${inv.settledTxid} — tx ${notice.refundTxid}`)
    return notice
  }
  const refundHeader = (n: RefundNotice) => encode(n)

  // Data to keep for a future refund
  const paidRecord = (inv: Invoice): PaidInvoice | undefined => inv.settledTxid && inv.rawtx && inv.refundScriptHex
    ? { id: inv.id, amount: inv.amount, lockingScriptHex: inv.lockingScriptHex, settledTxid: inv.settledTxid, rawtx: inv.rawtx, refundScriptHex: inv.refundScriptHex }
    : undefined

  return { requirePayment, invoiceKey, invoices, refund, refundHeader, paidRecord }
}
