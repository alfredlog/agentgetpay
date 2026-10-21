// Les interfaces du proxy. Le reste du code ne connaît QUE ces interfaces :
// pour passer en version entreprise, on écrit une nouvelle classe, sans toucher au proxy.
import type { Unlocker } from '../agent/pay-fetch.js'

export interface PaymentRequest {
  agentId: string
  url: string
  amountSats: number
  amountEur: number
  purpose?: string // pourquoi l'agent paie (pour l'audit)
}

export type Decision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'needs_approval'; reason: string }

// Décide AVANT la signature. Hackathon : règles JSON. Entreprise : Open Policy Agent.
export interface PolicyEngine {
  evaluate(req: PaymentRequest): Promise<Decision>
}

// Compte ce que chaque agent a dépensé aujourd'hui. Hackathon : mémoire. Entreprise : Redis.
export interface BudgetStore {
  spentToday(agentId: string): Promise<number> // en sats
  tryReserve(agentId: string, sats: number, limitSats: number): Promise<boolean>
  release(agentId: string, sats: number): Promise<void>
  reset(agentId: string): Promise<void> // remet le compteur du jour à zéro (administration)
}

// Garde les clés et signe. Hackathon : variable d'environnement. Entreprise : HashiCorp Vault.
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
  decision: Decision['kind'] | 'error' | 'admin' // 'admin' = modification des règles
  reason?: string
  txid?: string
  approvedBy?: string // qui a validé (Vier-Augen-Prinzip)
  action?: string     // pour les entrées 'admin' : type de modification (ex. 'budget_reset')
  prevHash: string
  hash: string
}

// Journal d'audit. Hackathon : fichier JSONL chaîné. Entreprise : Postgres + ancrage sur BSV.
export interface Ledger {
  record(e: Omit<LedgerEntry, 'seq' | 'ts' | 'prevHash' | 'hash'>): Promise<LedgerEntry>
  all(): Promise<LedgerEntry[]>
  verify(): Promise<{ ok: boolean; brokenAt?: number }>
}

// Demande l'accord d'un humain. Hackathon : Telegram. Entreprise : Microsoft Teams.
export interface ApprovalChannel {
  requestApproval(req: PaymentRequest, reason: string): Promise<{ status: 'approved' | 'rejected' | 'timeout'; by?: string }>
}
