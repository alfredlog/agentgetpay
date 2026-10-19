// Le VENDEUR : une API qui se fait payer par les agents via HTTP 402 (BRC-166).
// Dans la démo finale, ce rôle sera joué par PDF Libre.
import 'dotenv/config'
import express, { Request, Response } from 'express'
import { randomBytes } from 'node:crypto'
import { PrivateKey, Hash, Utils, P2PKH, Transaction, WhatsOnChainBroadcaster } from '@bsv/sdk'
import {
  NETWORK, PaymentRequired, PaymentRequirements, PaymentPayload, PaymentResponse, encode, decode
} from '../shared/x402.js'

const PORT = Number(process.env.SELLER_PORT ?? 4000)
const SECRET = process.env.SELLER_SECRET
if (!SECRET) throw new Error('SELLER_SECRET missing in .env (run npm run wallet)')
const SKIP_BROADCAST = process.env.SKIP_BROADCAST === '1' // pour tester sans réseau

interface Invoice {
  id: string
  resource: string // "GET /api/quote"
  amount: number
  lockingScriptHex: string
  payTo: string
  expiresAt: Date
  settledTxid?: string
}
const invoices = new Map<string, Invoice>()      // par lockingScriptHex
const locks = new Map<string, Promise<void>>()   // un paiement à la fois par facture

// Chaque facture a sa propre adresse, dérivée du secret + de l'id de facture.
function createInvoice(resource: string, amount: number): Invoice {
  const id = randomBytes(12).toString('hex')
  const key = new PrivateKey(Hash.sha256(Utils.toArray(`${SECRET}:${id}`, 'utf8')))
  const payTo = key.toAddress('testnet')
  const lockingScriptHex = new P2PKH().lock(payTo).toHex().toLowerCase()
  const inv = { id, resource, amount, payTo, lockingScriptHex, expiresAt: new Date(Date.now() + 15 * 60_000) }
  invoices.set(lockingScriptHex, inv)
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

// Middleware réutilisable : protège n'importe quelle route avec un prix.
function requirePayment(amount: number, description: string) {
  return async (req: Request, res: Response, next: () => void) => {
    const resource = `${req.method} ${req.path}`
    const header = req.get('PAYMENT-SIGNATURE')

    // 1. Pas de paiement → on répond 402 avec une facture neuve
    if (!header) {
      const inv = createInvoice(resource, amount)
      const body: PaymentRequired = {
        x402Version: 2,
        resource: { url: req.originalUrl, method: req.method, description },
        accepts: [requirements(inv)]
      }
      res.status(402).set('PAYMENT-REQUIRED', encode(body)).json(body)
      return
    }

    // 2. Lire le paiement
    let p: PaymentPayload
    try { p = decode<PaymentPayload>(header) } catch { return fail(res, 400, 'malformed_payment') }
    const script = (p.payload?.lockingScriptHex ?? p.accepted?.extra?.lockingScriptHex ?? '').toLowerCase()
    if (p.accepted?.scheme !== 'exact' || !script || !p.payload?.rawtx) return fail(res, 400, 'malformed_payment')

    const inv = invoices.get(script)
    if (!inv) return fail(res, 402, 'invoice_not_found')
    if (inv.resource !== resource) return fail(res, 402, 'resource_mismatch')

    // Un seul traitement à la fois pour une même facture
    const previous = locks.get(inv.id) ?? Promise.resolve()
    let release!: () => void
    locks.set(inv.id, new Promise<void>(r => (release = r)))
    await previous
    try {
      if (inv.settledTxid) return serve(inv.settledTxid)            // déjà payé : on resert sans facturer
      if (inv.expiresAt < new Date()) return fail(res, 402, 'invoice_expired')

      // 3. Vérifier le montant payé à l'adresse de la facture
      let tx: Transaction
      try { tx = Transaction.fromHex(p.payload.rawtx) } catch { return fail(res, 400, 'malformed_payment') }
      const paid = tx.outputs
        .filter(o => o.lockingScript.toHex().toLowerCase() === script)
        .reduce((s, o) => s + (o.satoshis ?? 0), 0)
      if (paid < inv.amount) return fail(res, 402, 'insufficient_funds', { required: inv.amount, paid })

      // 4. Diffuser la transaction sur le réseau (c'est le vendeur qui diffuse)
      const txid = tx.id('hex')
      if (!SKIP_BROADCAST) {
        const r = await tx.broadcast(new WhatsOnChainBroadcaster('test'))
        const known = r.status !== 'success' && /already|known|txn-already/i.test(JSON.stringify(r))
        if (r.status !== 'success' && !known) {
          return fail(res, 402, 'broadcast_rejected', { retryable: false, detail: r })
        }
      }

      // 5. Facture réglée → on sert la ressource
      inv.settledTxid = txid
      console.log(`Paid: ${inv.amount} sats for ${resource} — tx ${txid}`)
      serve(txid)
    } finally {
      release()
    }

    function serve(txid: string) {
      const pr: PaymentResponse = { success: true, transaction: txid, network: NETWORK, extensions: { status: 'mempool' } }
      res.set('PAYMENT-RESPONSE', encode(pr))
      next()
    }
  }
}

const app = express()

// Une ressource payante : 10 satoshis par appel
app.get('/api/quote', requirePayment(10, 'Quote of the day'), (_req, res) => {
  res.json({ quote: 'The best time to plant a tree was 20 years ago. The second best time is now.' })
})

// Deux ressources plus chères, pour tester les règles du proxy
app.get('/api/analysis', requirePayment(18, 'Market analysis'), (_req, res) => {
  res.json({ analysis: 'The market for AI agent payments is growing fast.' })
})
app.get('/api/report', requirePayment(30, 'Full report'), (_req, res) => {
  res.json({ report: 'Full 40-page report (simulated).' })
})

app.listen(PORT, () => console.log(`Seller ready on http://localhost:${PORT} — /api/quote (10 sats), /api/analysis (18), /api/report (30)`))
