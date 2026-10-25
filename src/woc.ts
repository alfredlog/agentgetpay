// Small client for the WhatsOnChain API (testnet).
const WOC = 'https://api.whatsonchain.com/v1/bsv/test'

export interface Utxo {
  tx_hash: string
  tx_pos: number
  value: number // in satoshis
  height: number // 0 = not confirmed yet (in the mempool)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Free WhatsOnChain limits the number of requests per second: beyond that it answers 429
// ("Too Many Requests"). We then wait a bit and retry, longer and longer.
async function wocFetch(url: string, tries = 5): Promise<Response> {
  for (let i = 1; ; i++) {
    const res = await fetch(url)
    if ((res.status !== 429 && res.status < 500) || i === tries) return res
    const wait = 1000 * 2 ** (i - 1) // 1 s, 2 s, 4 s, 8 s
    console.log(`WhatsOnChain busy (${res.status}), retrying in ${wait / 1000} s (${i}/${tries - 1})…`)
    await sleep(wait)
  }
}

interface WocUnspent extends Utxo { isSpentInMempoolTx?: boolean }

// We combine confirmed and unconfirmed coins, and remove those already spent
// in the mempool. (The old /unspent route does not see these spends: it returns
// coins that are already spent, which causes rejected double spends.)
export async function getUtxos(address: string): Promise<Utxo[]> {
  const lists = await Promise.all(['confirmed', 'unconfirmed'].map(async kind => {
    const res = await wocFetch(`${WOC}/address/${address}/${kind}/unspent`)
    // A brand-new address that never received anything is unknown to WhatsOnChain: 404 = no coins.
    if (res.status === 404) return []
    if (!res.ok) throw new Error(`WhatsOnChain responded ${res.status}`)
    const body = (await res.json()) as { result?: WocUnspent[] }
    return body.result ?? []
  }))
  return lists.flat()
    .filter(u => !u.isSpentInMempoolTx)
    .sort((a, b) => b.value - a.value) // the largest coin first: avoids dust
}

// A very recent transaction may return 404 for a few seconds:
// WhatsOnChain has not indexed it yet. So we retry several times.
export async function getTxHex(txid: string, tries = 5): Promise<string> {
  for (let i = 1; i <= tries; i++) {
    const res = await wocFetch(`${WOC}/tx/${txid}/hex`)
    if (res.ok) return res.text()
    if (res.status !== 404 || i === tries) {
      throw new Error(`Transaction ${txid} not found (${res.status}) after ${i} attempt(s)`)
    }
    console.log(`Transaction not indexed yet, retrying in 5 s (${i}/${tries})…`)
    await sleep(5000)
  }
  throw new Error('inaccessible')
}
