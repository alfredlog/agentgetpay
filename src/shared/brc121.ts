// BRC-121 (Simple 402 Payments) through the official @bsv/402-pay package.
//
// Loaded with `require`, like the SDK in bsv.ts: @bsv/402-pay also ships an ESM build that
// would pull in the ESM build of @bsv/sdk, i.e. a second copy of every SDK class next to
// the CJS one used by wallet-toolbox. Every file imports 402-pay from here.
import { createRequire } from 'node:module'
import type * as Server from '@bsv/402-pay/server' with { 'resolution-mode': 'require' }
import type * as Client from '@bsv/402-pay/client' with { 'resolution-mode': 'require' }
import type { WalletInterface } from './bsv.js'

const require = createRequire(import.meta.url)
const server: typeof Server = require('@bsv/402-pay/server')
const client: typeof Client = require('@bsv/402-pay/client')

export const { createPaymentMiddleware, InMemoryPaymentReplayStore } = server
export const { constructPaymentHeaders } = client
export type PaymentResult = Server.PaymentResult
export type PaymentReplayStore = Server.PaymentReplayStore
export type PaymentHeaders = Client.PaymentHeaders

// BRC-121 header names (same values as HEADERS in @bsv/402-pay)
export const BRC121 = {
  SATS: 'x-bsv-sats',     // server → client: price in satoshis
  SERVER: 'x-bsv-server', // server → client: merchant identity key
  BEEF: 'x-bsv-beef'      // client → server: the payment (AtomicBEEF, base64)
} as const

/**
 * @bsv/402-pay 0.3.3's client passes the request origin WITH its scheme
 * ("https://api.example.com") as the BRC-100 originator; wallet-toolbox wallets
 * require a bare hostname ("api.example.com") and reject the call. Wrap a
 * wallet-toolbox wallet with this before giving it to constructPaymentHeaders (guide §10.4).
 */
export function withHostOriginator (wallet: WalletInterface): WalletInterface {
  return new Proxy(wallet, {
    get (target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (args: unknown, originator?: string) =>
        value.call(target, args, typeof originator === 'string' ? originator.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') : originator)
    }
  })
}
