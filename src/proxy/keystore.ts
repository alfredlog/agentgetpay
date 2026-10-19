// Clés en variable d'environnement : OK pour le hackathon, jamais en production.
// Version entreprise : HashiCorp Vault, où la clé ne quitte jamais le coffre.
import { PrivateKey, P2PKH } from '@bsv/sdk'
import { KeyStore } from './types.js'

export class EnvKeyStore implements KeyStore {
  private key: PrivateKey
  constructor(wif: string) {
    this.key = PrivateKey.fromWif(wif)
  }
  // Pour la démo, tous les agents partagent le portefeuille de l'entreprise.
  address(_agentId: string) {
    return this.key.toAddress('testnet')
  }
  unlocker(_agentId: string) {
    return new P2PKH().unlock(this.key)
  }
}
