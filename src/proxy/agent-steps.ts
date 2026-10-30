// Steps the AGENT completes during a purchase. The proxy never calls into the agent (its MCP server may
// run behind NAT on a laptop): a purchase runs here as one piece of work, and whenever it needs the agent
// (co-sign a top-up, build the BRC-121 payment, internalize a refund) it ANSWERS the agent's pending HTTP
// request with a step. The agent completes it and resubmits (POST /v1/steps/:stepId); that request then
// receives the next step or the final result.
//
// A stepId is random, single use, bound to the agent that started the purchase, and expires after
// AGENT_STEP_TIMEOUT_MS (default 60 s): a replayed, foreign or late answer is refused.
import { randomBytes } from 'node:crypto'

export type StepKind = 'cosign-topup' | 'pay' | 'refund'
// Asks the agent for one step and waits for its answer
export type Ask = (step: StepKind, payload: Record<string, unknown>) => Promise<any>

export type Reply<T> = { kind: 'step'; step: StepKind; body: Record<string, unknown> } | { kind: 'done'; value: T }

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
const deferred = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

interface Session { reply: Deferred<Reply<unknown>> }
interface Pending { agentId: string; step: StepKind; session: Session; resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }

export class StepBroker {
  private pending = new Map<string, Pending>()
  constructor(private timeoutMs = Number(process.env.AGENT_STEP_TIMEOUT_MS ?? 60_000)) {}

  // Starts `work` for an agent. Resolves with its first step, or with its result if it needs no step.
  run<T>(agentId: string, work: (ask: Ask) => Promise<T>): Promise<Reply<T>> {
    const session: Session = { reply: deferred() }
    const ask: Ask = (step, payload) => new Promise((resolve, reject) => {
      const stepId = randomBytes(18).toString('base64url')
      const timer = setTimeout(() => {
        if (this.pending.delete(stepId)) reject(new Error(`The agent did not complete the step "${step}" in time`))
      }, this.timeoutMs)
      timer.unref()
      this.pending.set(stepId, { agentId, step, session, resolve, reject, timer })
      session.reply.resolve({ kind: 'step', step, body: { decision: 'agent_step', step, stepId, ...payload } })
    })
    work(ask).then(value => session.reply.resolve({ kind: 'done', value }), e => session.reply.reject(e))
    return session.reply.promise as Promise<Reply<T>>
  }

  // The agent's answer to a step. undefined: unknown, expired, already used, or another agent's step.
  answer(agentId: string, stepId: string, body: any): Promise<Reply<unknown>> | undefined {
    const p = this.pending.get(stepId)
    if (!p || p.agentId !== agentId) return undefined
    this.pending.delete(stepId) // single use
    clearTimeout(p.timer)
    p.session.reply = deferred() // this request now waits for the next step or the result
    const next = p.session.reply.promise
    if (body?.error !== undefined) p.reject(new Error(`The agent could not complete the step "${p.step}": ${String(body.error).slice(0, 200)}`))
    else p.resolve(body ?? {})
    return next
  }
}
