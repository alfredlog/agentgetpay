// Types et helpers du protocole x402 / BRC-166 (profil P2PKH, transaction brute).
export const NETWORK = 'bsv:testnet'

export interface PaymentRequirements {
  scheme: 'exact'
  network: string
  amount: string // en satoshis, sous forme de texte
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

// Ce que le marchand vend, décrit dans l'offre 402 (extension facultative).
// Le proxy s'en sert pour appliquer les règles d'achat : catégorie, prix unitaire, adresse de livraison.
export interface OrderItem {
  name: string
  quantity: number
  unitPriceSats: number
  unit?: string // ex. "night" (nuit d'hôtel), "item", "month"
}
export interface ShippingAddress {
  name?: string
  street: string
  postalCode: string
  city: string
  country: string // code ISO, ex. "DE"
}
export interface OrderInfo {
  merchant: string // nom du marchand, ex. "Alpenblick Hotel"
  category: string // ex. "travel.hotel", "office.supplies", "software.subscription"
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
}

export interface PaymentResponse {
  success: boolean
  transaction?: string
  network: string
  errorReason?: string
  extensions?: { status: string }
}

// Les en-têtes x402 transportent du JSON encodé en base64.
export const encode = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')

export const decode = <T>(b64: string): T =>
  JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as T
