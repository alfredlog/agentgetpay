// Kit vendeur : fait payer n'importe quelle route Express par des agents IA, via HTTP 402 (x402 / BRC-166, BSV).
//
//   const seller = createSeller({ secret: process.env.SELLER_SECRET! })
//   app.get('/api/report', seller.requirePayment(30, 'Full report'), (req, res) => res.json({ ... }))
//
// Le prix peut aussi être calculé à partir de la requête, avec la description de la commande
// (marchand, catégorie, articles, livraison) : l'acheteur peut alors appliquer sa politique d'achats.
//
// Chaque facture a sa propre adresse, dérivée du secret du vendeur : il peut retrouver la clé plus tard
// (par exemple pour rembourser) sans rien stocker d'autre que ce secret.
import type { Request, Response, NextFunction } from 'express'
import { randomBytes } from 'node:crypto'
import { PrivateKey, Hash, Utils, P2PKH, Transaction, WhatsOnChainBroadcaster, LockingScript } from '@bsv/sdk'
import {
  NETWORK, PaymentRequired, PaymentRequirements, PaymentPayload, PaymentResponse, OrderInfo, RefundNotice, encode, decode
} from './x402.js'

export interface Invoice {
  id: string
  resource: string // "POST /api/hotel/book"
  amount: number
  lockingScriptHex: string
  payTo: string
  expiresAt: Date
  settledTxid?: string
  order?: string // commande facturée (JSON) : la requête payée doit décrire exactement la même
  rawtx?: string           // la transaction de paiement (pour pouvoir rembourser)
  refundScriptHex?: string // où rembourser : l'adresse donnée par le payeur, sinon sa monnaie
}

// Ce qu'il faut garder d'une facture payée pour la rembourser plus tard (même après un redémarrage)
export type PaidInvoice = Pick<Invoice, 'id' | 'amount' | 'lockingScriptHex'> & { settledTxid: string; rawtx: string; refundScriptHex: string }

// Prix fixe, ou prix calculé à partir de la requête avec la description de la commande
export type Pricing = number | ((req: Request) => { amount: number; order?: OrderInfo } | { error: string })

export interface SellerOptions {
  secret: string
  skipBroadcast?: boolean // pour tester sans réseau
  invoiceMinutes?: number
  // Appelé quand une facture est payée (journal du vendeur, page "commandes récentes"…)
  onPaid?: (inv: Invoice, txid: string, req: Request) => void
  log?: (msg: string) => void
}

export function createSeller(o: SellerOptions) {
  if (!o.secret) throw new Error('Seller secret missing')
  const invoices = new Map<string, Invoice>()      // par lockingScriptHex
  const locks = new Map<string, Promise<void>>()   // un paiement à la fois par facture
  const log = o.log ?? ((m: string) => console.log(m))

  // La clé privée d'une facture (pour un remboursement, par exemple)
  const invoiceKey = (id: string) => new PrivateKey(Hash.sha256(Utils.toArray(`${o.secret}:${id}`, 'utf8')))

  function createInvoice(resource: string, amount: number, order?: OrderInfo): Invoice {
    const id = randomBytes(12).toString('hex')
    const payTo = invoiceKey(id).toAddress('testnet')
    const lockingScriptHex = new P2PKH().lock(payTo).toHex().toLowerCase()
    const inv: Invoice = {
      id, resource, amount, payTo, lockingScriptHex,
      expiresAt: new Date(Date.now() + (o.invoiceMinutes ?? 15) * 60_000), order: order ? JSON.stringify(order) : undefined
    }
    invoices.set(lockingScriptHex, inv)
    // Ménage : on oublie les factures expirées et jamais payées
    if (invoices.size > 5000) for (const [k, v] of invoices) if (!v.settledTxid && v.expiresAt < new Date()) invoices.delete(k)
    return inv
  }

  function requirements(inv: Invoice): PaymentRequirements {
    return {
      scheme: 'exact', network: NETWORK, amount: String(inv.amount), asset: 'BSV',
      payTo: inv.payTo, maxTimeoutSeconds: 900,
      extra: {
        chain: 'bsv', unit: 'satoshi', invoiceId: inv.id, lockingScriptHex: inv.lockingScriptHex,
        expiresAt: inv.expiresAt.toISOString(), payloadFormat: { kind: 'p2pkh-rawtx' }
      }
    }
  }

  function fail(res: Response, status: number, reason: string, extra: object = {}) {
    const pr: PaymentResponse = { success: false, network: NETWORK, errorReason: reason }
    res.status(status).set('PAYMENT-RESPONSE', encode(pr)).json({ error: reason, ...extra })
  }

  // Middleware : protège une route avec un prix
  function requirePayment(pricing: Pricing, description: string) {
    return async (req: Request, res: Response, next: NextFunction) => {
      const resource = `${req.method} ${req.path}`
      const header = req.get('PAYMENT-SIGNATURE')
      const priced = typeof pricing === 'number' ? { amount: pricing, order: undefined } : pricing(req)
      if ('error' in priced) return void res.status(400).json({ error: priced.error })
      const { amount, order } = priced

      // 1. Pas de paiement → 402 avec une facture neuve (et la description de la commande)
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

      // 2. Lire le paiement
      let p: PaymentPayload
      try { p = decode<PaymentPayload>(header) } catch { return fail(res, 400, 'malformed_payment') }
      const script = (p.payload?.lockingScriptHex ?? p.accepted?.extra?.lockingScriptHex ?? '').toLowerCase()
      if (p.accepted?.scheme !== 'exact' || !script || !p.payload?.rawtx) return fail(res, 400, 'malformed_payment')

      const inv = invoices.get(script)
      if (!inv) return fail(res, 402, 'invoice_not_found')
      if (inv.resource !== resource) return fail(res, 402, 'resource_mismatch')
      // On ne peut pas payer une commande puis en recevoir une autre (plus chère, autre adresse…)
      if (inv.order !== (order ? JSON.stringify(order) : undefined)) return fail(res, 402, 'order_mismatch')

      // Un seul traitement à la fois pour une même facture
      const previous = locks.get(inv.id) ?? Promise.resolve()
      let release!: () => void
      locks.set(inv.id, new Promise<void>(r => (release = r)))
      await previous
      try {
        if (inv.settledTxid) return serve(inv.settledTxid, false) // déjà payé : on resert sans facturer
        if (inv.expiresAt < new Date()) return fail(res, 402, 'invoice_expired')

        // 3. Vérifier le montant payé à l'adresse de la facture
        let tx: Transaction
        try { tx = Transaction.fromHex(p.payload.rawtx) } catch { return fail(res, 400, 'malformed_payment') }
        const paid = tx.outputs
          .filter(out => out.lockingScript.toHex().toLowerCase() === script)
          .reduce((s, out) => s + (out.satoshis ?? 0), 0)
        if (paid < inv.amount) return fail(res, 402, 'insufficient_funds', { required: inv.amount, paid })

        // 4. Diffuser la transaction sur le réseau (c'est le vendeur qui diffuse)
        const txid = tx.id('hex')
        if (!o.skipBroadcast) {
          const r = await tx.broadcast(new WhatsOnChainBroadcaster('test'))
          const known = r.status !== 'success' && /already|known|txn-already/i.test(JSON.stringify(r))
          if (r.status !== 'success' && !known) return fail(res, 402, 'broadcast_rejected', { retryable: false, detail: r })
        }

        // 5. Facture réglée → on sert la ressource. On garde de quoi rembourser.
        inv.settledTxid = txid
        inv.rawtx = p.payload.rawtx
        try {
          const to = p.extensions?.refundTo
          inv.refundScriptHex = to ? new P2PKH().lock(to).toHex()
            : tx.outputs.find(out => out.lockingScript.toHex().toLowerCase() !== script)?.lockingScript.toHex() // la monnaie du payeur
        } catch { inv.refundScriptHex = undefined }
        log(`Paid: ${inv.amount} sats for ${resource} — tx ${txid}`)
        serve(txid, true)
      } finally {
        release()
        locks.delete(inv.id)
      }

      function serve(txid: string, fresh: boolean) {
        const pr: PaymentResponse = { success: true, transaction: txid, network: NETWORK, extensions: { status: 'mempool' } }
        res.set('PAYMENT-RESPONSE', encode(pr))
        res.locals.payment = { invoice: inv!, txid, replay: !fresh }
        if (fresh) o.onPaid?.(inv!, txid, req)
        next()
      }
    }
  }

  // Rembourse une facture payée : renvoie l'argent au payeur (moins les frais du réseau, et moins keepSats
  // si le vendeur garde des frais d'annulation). Le résultat va dans l'en-tête PAYMENT-REFUND de la réponse.
  async function refund(inv: PaidInvoice, keepSats = 0): Promise<RefundNotice> {
    const paidTx = Transaction.fromHex(inv.rawtx)
    const index = paidTx.outputs.findIndex(out => out.lockingScript.toHex().toLowerCase() === inv.lockingScriptHex)
    if (index < 0) throw new Error('Payment output not found')
    const value = paidTx.outputs[index].satoshis ?? 0
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: paidTx, sourceOutputIndex: index, unlockingScriptTemplate: new P2PKH().unlock(invoiceKey(inv.id)) })
    if (keepSats > 0) tx.addOutput({ lockingScript: new P2PKH().lock(invoiceKey(inv.id).toAddress('testnet')), satoshis: Math.min(keepSats, value) })
    tx.addOutput({ lockingScript: LockingScript.fromHex(inv.refundScriptHex), change: true })
    await tx.fee()
    const back = tx.outputs.at(-1)?.satoshis ?? 0
    if (back < 1) throw new Error('Amount too small to refund after network fees')
    await tx.sign()
    if (!o.skipBroadcast) {
      const r = await tx.broadcast(new WhatsOnChainBroadcaster('test'))
      if (r.status !== 'success' && !/already|known|txn-already/i.test(JSON.stringify(r))) throw new Error(`Refund rejected by the network: ${JSON.stringify(r).slice(0, 200)}`)
    }
    const notice = { paymentTxid: inv.settledTxid, refundTxid: tx.id('hex'), rawtx: tx.toHex(), sats: back }
    log(`Refunded ${back} sats for ${inv.settledTxid} — tx ${notice.refundTxid}`)
    return notice
  }
  const refundHeader = (n: RefundNotice) => encode(n)

  // Données à garder pour un remboursement futur
  const paidRecord = (inv: Invoice): PaidInvoice | undefined => inv.settledTxid && inv.rawtx && inv.refundScriptHex
    ? { id: inv.id, amount: inv.amount, lockingScriptHex: inv.lockingScriptHex, settledTxid: inv.settledTxid, rawtx: inv.rawtx, refundScriptHex: inv.refundScriptHex }
    : undefined

  return { requirePayment, invoiceKey, invoices, refund, refundHeader, paidRecord }
}
