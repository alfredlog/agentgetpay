// Interface pour trouver les pièces (UTXO) d'une adresse.
// Implémentation réelle : WhatsOnChain. En test : une version simulée.
import { Transaction } from '@bsv/sdk'
import { getUtxos, getTxHex } from '../woc.js'

export interface SpendableUtxo {
  sourceTransaction: Transaction
  outputIndex: number
  satoshis: number
}

export interface UtxoProvider {
  findUtxo(address: string, minSats: number): Promise<SpendableUtxo | undefined>
}

export class WhatsOnChainUtxoProvider implements UtxoProvider {
  async findUtxo(address: string, minSats: number) {
    const u = (await getUtxos(address)).find(x => x.value >= minSats)
    if (!u) return undefined
    return {
      sourceTransaction: Transaction.fromHex(await getTxHex(u.tx_hash)),
      outputIndex: u.tx_pos,
      satoshis: u.value
    }
  }
}

// Enchaîne les paiements sans attendre WhatsOnChain : après chaque paiement réussi,
// la "monnaie" de notre propre transaction devient la pièce du paiement suivant.
// Sans ça, deux paiements rapides réutiliseraient la même pièce → double dépense refusée.
export class ChainedUtxoProvider implements UtxoProvider {
  private next?: SpendableUtxo
  private spent = new Set<string>()

  constructor(private inner: UtxoProvider) {}

  remember(tx: Transaction) {
    for (const i of tx.inputs) this.spent.add(`${i.sourceTXID ?? i.sourceTransaction?.id('hex')}:${i.sourceOutputIndex}`)
    const idx = tx.outputs.findIndex(o => o.change)
    this.next = idx >= 0 ? { sourceTransaction: tx, outputIndex: idx, satoshis: tx.outputs[idx].satoshis ?? 0 } : undefined
  }

  async findUtxo(address: string, minSats: number) {
    if (this.next && this.next.satoshis >= minSats) return this.next
    const u = await this.inner.findUtxo(address, minSats)
    if (u && this.spent.has(`${u.sourceTransaction.id('hex')}:${u.outputIndex}`)) return undefined
    return u
  }
}
