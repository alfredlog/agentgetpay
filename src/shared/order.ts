// What a merchant sells, as described by its free quote endpoint (see seller-kit.ts).
// Payment itself uses BRC-121 (@bsv/402-pay): its 402 answer only carries the price
// (x-bsv-sats) and the merchant's identity key (x-bsv-server). The order details reach
// the buyer's proxy BEFORE payment through the quote, so the purchase policy (category,
// unit price, delivery address) can be applied first.

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

// Free quote endpoint. This is an AgentGetPay convention, NOT part of BRC-121: a BRC-121
// merchant without it still gets paid, only without order details for the policy.
//   POST <origin>/.well-known/payment-quote  { method, path, body } → Quote
export const QUOTE_PATH = '/.well-known/payment-quote'
export interface QuoteRequest { method: string; path: string; body?: unknown }
export interface Quote { sats: number; description?: string; order?: OrderInfo }
