// The proxy's interfaces. The rest of the code ONLY knows these interfaces:
// to move to the enterprise version, write a new class without touching the proxy.
import type { Unlocker } from '../agent/pay-fetch.js'
import type { OrderInfo } from '../shared/x402.js'

export interface PaymentRequest {
  agentId: string
  url: string
  amountSats: number
  amountEur: number
  purpose?: string // why the agent pays (for the audit)
  rail?: 'bsv' | 'card' // how it would be paid (default: BSV via HTTP 402)
  order?: OrderInfo // what is bought, if the merchant describes it (category, items, delivery)
}

export type Decision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'needs_approval'; reason: string }

// Decides BEFORE signing. Hackathon: JSON rules. Enterprise: Open Policy Agent.
export interface PolicyEngine {
  evaluate(req: PaymentRequest): Promise<Decision>
}

// Limits to respect when reserving (in sats)
export interface BudgetLimits {
  daySats: number
  monthSats?: number
  category?: string         // full category of the purchase, e.g. "travel.hotel"
  categoryKey?: string      // category carrying the limit, e.g. "travel"
  categoryMonthSats?: number
}

// Counts what each agent spent (day, month, month per category). Hackathon: memory. Enterprise: Redis.
export interface BudgetStore {
  spentToday(agentId: string): Promise<number> // in sats
  spentThisMonth(agentId: string, category?: string): Promise<number> // in sats
  // Reserves the amount if NO limit is exceeded; otherwise returns the reason for refusing
  tryReserve(agentId: string, sats: number, limits: BudgetLimits): Promise<string | undefined>
  release(agentId: string, sats: number, category?: string): Promise<void>
  reset(agentId: string): Promise<void> // resets the daily counter (administration)
  credit(agentId: string, sats: number, category: string | undefined, originalTs: string): void // refund
}

// Holds the keys and signs. Hackathon: environment variable. Enterprise: HashiCorp Vault.
export interface KeyStore {
  address(agentId: string): string
  unlocker(agentId: string): Unlocker
}

export interface LedgerEntry {
  seq: number
  ts: string
  agentId: string
  url: string
  amountSats: number
  amountEur: number
  purpose?: string
  decision: Decision['kind'] | 'error' | 'admin' | 'refund' | 'card' // 'admin' = rule change; 'refund' = refund received; 'card' = virtual card issued
  reason?: string
  txid?: string
  order?: OrderInfo   // what was bought (merchant, category, items, delivery)
  approvedBy?: string // who approved (four-eyes principle, Vier-Augen-Prinzip)
  action?: string     // for 'admin' entries: type of change (e.g. 'budget_reset')
  requestId?: string  // related approval request (R-…)
  mandateId?: string  // payment covered by a mandate (M-…)
  refundOf?: string
  rail?: 'bsv' | 'card' // how it was paid (default: BSV)
  cardId?: string     // card rail: the virtual card used
  authId?: string     // card rail: the card authorization id (the receipt reference)   // for a refund: the transaction of the refunded payment
  prevHash: string
  hash: string
}

// Audit log. Hackathon: hash-chained JSONL file. Enterprise: Postgres + anchoring on BSV.
export interface Ledger {
  record(e: Omit<LedgerEntry, 'seq' | 'ts' | 'prevHash' | 'hash'>): Promise<LedgerEntry>
  all(): Promise<LedgerEntry[]>
  verify(): Promise<{ ok: boolean; brokenAt?: number }>
}

// Asks a human for approval: see approval.ts (ApprovalNotifier) and requests.ts (stored requests).
