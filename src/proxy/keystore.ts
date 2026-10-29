// Keys in an environment variable: fine for the hackathon, never in production.
// Enterprise version: HashiCorp Vault, where the key never leaves the vault.
import { PrivateKey, P2PKH } from '../shared/bsv.js'
import { KeyStore } from './types.js'
import { addressNetwork } from '../shared/network.js'

export class EnvKeyStore implements KeyStore {
  private key: PrivateKey
  constructor(wif: string) {
    this.key = PrivateKey.fromWif(wif)
  }
  // For the demo, all agents share the company wallet.
  address(_agentId: string) {
    return this.key.toAddress(addressNetwork())
  }
  unlocker(_agentId: string) {
    return new P2PKH().unlock(this.key)
  }
}
