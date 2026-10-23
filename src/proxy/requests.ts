// Requests waiting for a human decision: a purchase above the threshold, or a mandate (recurring purchases).
//
// An approval can take hours or days: the request is therefore STORED (it survives a
// restart), the agent carries on with its work, and as soon as a human approves, the proxy executes the purchase by itself.
// The agent then fetches the result (check_request), or receives a call on its callback address.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { OrderInfo } from '../shared/x402.js'

export type RequestStatus =
  | 'pending'    // waiting for a decision
  | 'approved'   // approved, execution in progress
  | 'completed'  // approved and executed (purchase paid, or mandate created)
  | 'rejected'   // rejected by a human
  | 'expired'    // no answer in time
  | 'failed'     // approved, but execution failed (price increased, budget exhausted, service down…)

export interface MandateTerms {
  domain: string            // merchant (domain) concerned
  category?: string         // category covered, e.g. "software.subscription"
  maxEurPerMonth: number    // monthly limit covered by the mandate
  months: number            // duration
}

export interface StoredRequest {
  id: string                 // e.g. "R-7K2Q9D"
  kind: 'payment' | 'mandate'
  agentId: string
  purpose?: string
  reason: string             // why an approval is needed
  createdAt: string
  expiresAt: string
  status: RequestStatus
  decidedBy?: string
  decidedAt?: string
  // Purchase
  url?: string
  method?: string
  amountSats?: number        // approved amount: the execution will never pay more
  amountEur?: number
  order?: OrderInfo
  callbackUrl?: string       // the agent is notified here when the request is finished
  // Mandate
  mandate?: MandateTerms
  // Result
  result?: { status: number; contentType: string; paidSats?: number; txid?: string; mandateId?: string; error?: string }
  // Approval messages sent (to update them later: Telegram…)
  notices?: Record<string, unknown>
}

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const newId = () => 'R-' + Array.from(randomBytes(6), b => ALPHABET[b % ALPHABET.length]).join('')

export class RequestStore {
  private items: StoredRequest[]
  private file: string

  constructor(private dir = 'data/requests') {
    this.file = join(dir, 'index.json')
    mkdirSync(dir, { recursive: true })
    this.items = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : []
  }

  private save() {
    // Keep at most 1000 finished requests (the most recent ones)
    const open = this.items.filter(r => r.status === 'pending' || r.status === 'approved')
    const done = this.items.filter(r => r.status !== 'pending' && r.status !== 'approved')
    if (done.length > 1000) for (const r of done.splice(0, done.length - 1000)) this.removeFiles(r.id)
    this.items = [...done, ...open].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.items, null, 2))
    renameSync(`${this.file}.tmp`, this.file)
  }

  private removeFiles(id: string) {
    for (const ext of ['body', 'result']) rmSync(join(this.dir, `${id}.${ext}`), { force: true })
  }

  create(r: Omit<StoredRequest, 'id' | 'createdAt' | 'status'>, body?: unknown): StoredRequest {
    let id = newId()
    while (this.get(id)) id = newId()
    const item: StoredRequest = { ...r, id, createdAt: new Date().toISOString(), status: 'pending' }
    // The request body (sometimes a PDF in base64) is kept separately, for the execution
    if (body !== undefined) writeFileSync(join(this.dir, `${id}.body`), JSON.stringify(body))
    this.items.push(item)
    this.save()
    return item
  }

  get(id: string) { return this.items.find(r => r.id === id) }
  list(filter?: (r: StoredRequest) => boolean) { return filter ? this.items.filter(filter) : [...this.items] }
  open() { return this.items.filter(r => r.status === 'pending') }

  update(id: string, patch: Partial<StoredRequest>) {
    const r = this.get(id)
    if (!r) return undefined
    Object.assign(r, patch)
    this.save()
    return r
  }

  body(id: string): unknown {
    const p = join(this.dir, `${id}.body`)
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined
  }

  saveResult(id: string, data: Buffer) { writeFileSync(join(this.dir, `${id}.result`), data) }
  result(id: string): Buffer | undefined {
    const p = join(this.dir, `${id}.result`)
    return existsSync(p) ? readFileSync(p) : undefined
  }
  dropBody(id: string) { rmSync(join(this.dir, `${id}.body`), { force: true }) }
}
