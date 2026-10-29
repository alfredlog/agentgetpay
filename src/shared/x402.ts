// Types and helpers of the x402 / BRC-166 protocol (P2PKH profile, raw transaction).
// The network name ('bsv:mainnet' | 'bsv:testnet') comes from BSV_NETWORK: x402Network() in network.ts

export interface PaymentRequirements {
  scheme: 'exact'
  network: string
  amount: string // in satoshis, as text
  asset: 'BSV'
  payTo: string
  maxTimeoutSeconds: number
  extra: {
    chain: 'bsv'
    unit: 'satoshi'
    invoiceId: string
    lockingScriptHex: string
    expiresAt: string
    payloadFormat: { kind: 'p2pkh-rawtx' }
  }
}

// What the merchant sells, described in the 402 offer (optional extension).
// The proxy uses it to apply the purchase rules: category, unit price, delivery address.
export interface OrderItem {
  name: string
  quantity: number
  unitPriceSats: number
  unit?: string // e.g. "night" (hotel night), "item", "month"
}
export interface ShippingAddress {
  name?: string
  street: string
  postalCode: string
  city: string
  country: string // ISO code, e.g. "DE"
}
export interface OrderInfo {
  merchant: string // merchant name, e.g. "Alpenblick Hotel"
  category: string // e.g. "travel.hotel", "office.supplies", "software.subscription"
  items: OrderItem[]
  shipTo?: ShippingAddress
}

export interface PaymentRequired {
  x402Version: 2
  resource: { url: string; method: string; description?: string }
  accepts: PaymentRequirements[]
  extensions?: { order?: OrderInfo }
}

export interface PaymentPayload {
  x402Version: 2
  accepted: PaymentRequirements
  payload: { lockingScriptHex: string; rawtx: string }
  // Where to send the money back if the order is cancelled (payer's address)
  extensions?: { refundTo?: string }
}

// Refund announced by the seller (PAYMENT-REFUND header): the transaction that pays the money back
export interface RefundNotice {
  paymentTxid: string
  refundTxid: string
  rawtx: string
  sats: number
}

export interface PaymentResponse {
  success: boolean
  transaction?: string
  network: string
  errorReason?: string
  extensions?: { status: string }
}

// x402 headers carry base64-encoded JSON.
export const encode = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')

export const decode = <T>(b64: string): T =>
  JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as T
