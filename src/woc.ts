// Petit client pour l'API WhatsOnChain (testnet).
const WOC = 'https://api.whatsonchain.com/v1/bsv/test'

export interface Utxo {
  tx_hash: string
  tx_pos: number
  value: number // en satoshis
  height: number // 0 = pas encore confirmée (dans le mempool)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// WhatsOnChain gratuit limite le nombre de requêtes par seconde : au-delà, il répond 429
// ("Too Many Requests"). On attend alors un peu et on réessaie, de plus en plus longtemps.
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

// On combine les pièces confirmées et non confirmées, et on enlève celles déjà dépensées
// dans le mempool. (L'ancienne route /unspent ne voit pas ces dépenses : elle renvoie
// des pièces déjà dépensées, ce qui provoque des doubles dépenses refusées.)
export async function getUtxos(address: string): Promise<Utxo[]> {
  const lists = await Promise.all(['confirmed', 'unconfirmed'].map(async kind => {
    const res = await wocFetch(`${WOC}/address/${address}/${kind}/unspent`)
    // Une adresse toute neuve, qui n'a jamais rien reçu, est inconnue de WhatsOnChain : 404 = aucune pièce.
    if (res.status === 404) return []
    if (!res.ok) throw new Error(`WhatsOnChain responded ${res.status}`)
    const body = (await res.json()) as { result?: WocUnspent[] }
    return body.result ?? []
  }))
  return lists.flat()
    .filter(u => !u.isSpentInMempoolTx)
    .sort((a, b) => b.value - a.value) // la plus grosse pièce d'abord : évite les miettes
}

// Une transaction toute récente peut renvoyer 404 quelques secondes :
// WhatsOnChain ne l'a pas encore indexée. On réessaie donc plusieurs fois.
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
