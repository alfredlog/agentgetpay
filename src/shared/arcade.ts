// Arcade (BSV Association broadcast manager): broadcasting and block headers (guide §20).
// It replaces WhatsOnChain for both; WhatsOnChain stays for explorer links and the address index.
import { type Broadcaster, type BroadcastResponse, type BroadcastFailure, type ChainTracker, type Transaction } from './bsv.js'
import { bsvNetwork } from './network.js'

export const ARCADE_MAINNET = 'https://arcade-v2-us-1.bsvblockchain.tech'
export const ARCADE_TESTNET = 'https://arcade-v2-testnet-us-1.bsvblockchain.tech'

// ARCADE_URL wins; otherwise the public instance of the network chosen by BSV_NETWORK
export const arcadeUrl = () => (process.env.ARCADE_URL || (bsvNetwork() === 'main' ? ARCADE_MAINNET : ARCADE_TESTNET)).replace(/\/+$/, '')

type Fetch = typeof fetch

/**
 * Minimal SDK ChainTracker backed by Arcade's go-chaintracks REST API (guide §20.3, Appendix A).
 * Use it anywhere the SDK asks for a chain tracker, e.g.
 * `await Transaction.fromAtomicBEEF(beef).verify(new ArcadeChainTracker())`.
 *
 *   GET {url}/chaintracks/v2/height                → { height }
 *   GET {url}/chaintracks/v2/header/height/{h}     → { merkleRoot, hash, … }
 *
 * Block headers never change once buried, so verified roots are cached.
 */
export class ArcadeChainTracker implements ChainTracker {
  private readonly roots = new Map<number, string>()

  constructor (private readonly url = arcadeUrl(), private readonly fetchFn: Fetch = fetch) {}

  async isValidRootForHeight (root: string, height: number): Promise<boolean> {
    let known = this.roots.get(height)
    if (known === undefined) {
      const res = await this.fetchFn(`${this.url}/chaintracks/v2/header/height/${height}`)
      if (res.status === 404) return false
      if (!res.ok) throw new Error(`Arcade header request failed (${res.status})`)
      known = String((await res.json() as { merkleRoot: string }).merkleRoot).toLowerCase()
      this.roots.set(height, known)
    }
    return known === root.toLowerCase()
  }

  async currentHeight (): Promise<number> {
    const res = await this.fetchFn(`${this.url}/chaintracks/v2/height`)
    if (!res.ok) throw new Error(`Arcade height request failed (${res.status})`)
    return (await res.json() as { height: number }).height
  }
}

// Statuses that mean "refused" although the HTTP call succeeded (same sets as wallet-toolbox's ARC/Arcade)
const DOUBLE_SPEND = new Set(['DOUBLE_SPEND_ATTEMPTED', 'SEEN_IN_ORPHAN_MEMPOOL'])
const INVALID = new Set(['INVALID', 'MALFORMED', 'REJECTED'])

interface ArcadeTxResponse { txid?: string; txStatus?: string; extraInfo?: string; competingTxs?: string[]; detail?: string; title?: string }

/**
 * Broadcaster for Arcade's `POST /tx` (guide §20.1).
 * Arcade expects Extended Format (EF), not BEEF: EF carries each input's source satoshis and
 * script, which Arcade needs for fee and script checks. EF needs every input's source
 * transaction; when one is missing (e.g. a payment received as plain raw hex) we send the
 * raw transaction instead, which Arcade also parses.
 * The request body mirrors wallet-toolbox's Arcade provider: JSON `{ rawTx: <hex> }`.
 */
export class ArcadeBroadcaster implements Broadcaster {
  constructor (private readonly url = arcadeUrl(), private readonly fetchFn: Fetch = fetch) {}

  async broadcast (tx: Transaction): Promise<BroadcastResponse | BroadcastFailure> {
    const txid = tx.id('hex')
    const hasSources = tx.inputs.every(i => i.sourceTransaction !== undefined)
    const rawTx = hasSources ? tx.toHexEF() : tx.toHex()
    try {
      const res = await this.fetchFn(`${this.url}/tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawTx }),
        signal: AbortSignal.timeout(30_000)
      })
      const text = await res.text()
      let body: ArcadeTxResponse = {}
      try { body = JSON.parse(text) } catch { /* not JSON: kept as the description below */ }
      const status = body.txStatus ?? ''
      if (!res.ok) {
        return { status: 'error', code: String(res.status), txid, description: body.detail ?? body.title ?? (status || text.slice(0, 200)), more: body }
      }
      if (DOUBLE_SPEND.has(status)) {
        return { status: 'error', code: 'DOUBLE_SPEND', txid, description: `${status}${body.competingTxs?.length ? ` (competing: ${body.competingTxs.join(',')})` : ''}`, more: body }
      }
      if (INVALID.has(status)) {
        return { status: 'error', code: status, txid, description: body.extraInfo || status, more: body }
      }
      return { status: 'success', txid: body.txid ?? txid, message: [status, body.extraInfo].filter(Boolean).join(' ') || 'broadcast' }
    } catch (e) {
      return { status: 'error', code: 'NETWORK', txid, description: `Arcade unreachable: ${(e as Error).message}` }
    }
  }
}
