// Interface to find the coins (UTXO) of an address.
// Real implementation: WhatsOnChain. In tests: a simulated version.
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

// Chains payments without waiting for WhatsOnChain: after each successful payment,
// the "change" of our own transaction becomes the coin of the next payment.
// Without this, two quick payments would reuse the same coin → double spend refused.
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
