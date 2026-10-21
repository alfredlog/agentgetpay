// Le côté AGENT : un fetch() qui sait payer automatiquement une réponse 402.
// À l'étape 3, ce code deviendra le Payment proxy, avec le moteur de règles branché sur `beforePay`.
import { Transaction, P2PKH, LockingScript } from '@bsv/sdk'
import { NETWORK, PaymentRequired, PaymentPayload, PaymentResponse, encode, decode } from '../shared/x402.js'
import { UtxoProvider } from '../shared/utxo.js'
import { Mutex } from '../shared/mutex.js'

export type Unlocker = ReturnType<P2PKH['unlock']>

export interface PayFetchOptions {
  address: string          // adresse testnet du payeur
  unlocker: () => Unlocker // signe les entrées ; la clé reste dans le KeyStore
  utxos: UtxoProvider
  maxSats?: number // garde-fou simple, remplacé par le moteur de règles à l'étape 3
  beforePay?: (offer: { url: string; amount: number; payTo: string }) => Promise<boolean>
  spendLock?: Mutex                // un seul paiement à la fois dépense le portefeuille
  onSpent?: (tx: Transaction) => void // appelé dans le verrou quand le vendeur a accepté
}

export interface PayFetchResult {
  response: Response
  paid?: { amount: number; txid: string; tx: Transaction }
}

export async function payFetch(url: string, init: RequestInit, opts: PayFetchOptions): Promise<PayFetchResult> {
  // 1. Première tentative, sans payer
  const first = await fetch(url, init)
  if (first.status !== 402) return { response: first }

  // 2. Lire l'offre de paiement
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
  if (opts.beforePay && !(await opts.beforePay({ url, amount, payTo: req.payTo }))) {
    throw new Error('Payment refused by beforePay rule')
  }

  const spend = async () => {
    // 3. Construire et signer la transaction (sans la diffuser : c'est le vendeur qui diffuse)
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

    // 4. Renvoyer la même requête avec la preuve de paiement
    const payment: PaymentPayload = {
      x402Version: 2,
      accepted: req,
      payload: { lockingScriptHex: req.extra.lockingScriptHex, rawtx: tx.toHex() }
    }
    const headers = new Headers(init.headers)
    headers.set('PAYMENT-SIGNATURE', encode(payment))
    const second = await fetch(url, { ...init, headers })

    const receiptHeader = second.headers.get('PAYMENT-RESPONSE')
    const receipt = receiptHeader ? decode<PaymentResponse>(receiptHeader) : undefined
    if (!second.ok || !receipt?.success) {
      // Pas de reçu de paiement : c'est le service qui a refusé le travail (fichier invalide…),
      // la transaction n'a pas été diffusée, donc rien n'a été payé.
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
