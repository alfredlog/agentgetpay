// Server wallets (wallet-toolbox, guide §14): the merchants' wallets (they receive BRC-121
// payments and send refunds), the proxy's policy wallet and the agents' wallets (src/allowance).
//
// Broadcasting: Arcade first (guide §14.2), then wallet-toolbox's default providers.
// The root key comes from an environment variable; it is never printed or written to logs.
//
// Offline tests: with MOCK_CHAIN_DB set, the wallet runs on wallet-toolbox's mock chain,
// stored in that SQLite file so that the proxy and the merchants (separate processes) share
// one chain (src/test/helpers/mockchain.ts).
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type * as Toolbox from '@bsv/wallet-toolbox' with { 'resolution-mode': 'require' }
import { CachedKeyDeriver, PrivateKey, type Broadcaster, type ChainTracker, type WalletInterface } from './bsv.js'
import { arcadeUrl, ArcadeBroadcaster, ArcadeChainTracker } from './arcade.js'
import { bsvNetwork } from './network.js'

const require = createRequire(import.meta.url)
// wallet-toolbox is CommonJS: `require` gives the same module (and the same SDK build) everywhere
export const toolbox: typeof Toolbox = require('@bsv/wallet-toolbox')

export interface ServerWalletOptions {
  rootKeyHex: string   // 64 hex characters, from an environment variable
  filePath: string     // SQLite storage of the wallet
  databaseName: string // name of the wallet inside the storage
}

export async function openServerWallet (o: ServerWalletOptions): Promise<WalletInterface> {
  if (!/^[0-9a-fA-F]{64}$/.test(o.rootKeyHex)) throw new Error(`Wallet key for ${o.databaseName} must be 64 hex characters`)
  mkdirSync(dirname(o.filePath), { recursive: true })
  if (process.env.MOCK_CHAIN_DB) {
    const { openMockChain } = await import('../test/helpers/mockchain.js')
    return (await openMockChain(process.env.MOCK_CHAIN_DB)).makeWallet(PrivateKey.fromHex(o.rootKeyHex), o.filePath)
  }

  const { Monitor, Services, Setup, StorageKnex, Wallet, WalletStorageManager } = toolbox
  const chain = bsvNetwork()
  const rootKey = PrivateKey.fromHex(o.rootKeyHex)
  const identityKey = rootKey.toPublicKey().toString()

  const options = Services.createDefaultOptions(chain)
  options.arcadeUrl = arcadeUrl()
  const services = new Services(options) // broadcast order: Arcade, GorillaPool, TAAL, Bitails, WhatsOnChain

  const storage = new StorageKnex({ ...StorageKnex.createStorageBaseOptions(chain), knex: Setup.createSQLiteKnex(o.filePath) })
  await storage.migrate(o.databaseName, identityKey)
  await storage.makeAvailable()
  const manager = new WalletStorageManager(identityKey, storage)
  await manager.makeAvailable()
  manager.setServices(services)

  const monitor = new Monitor(Monitor.createDefaultWalletMonitorOptions(chain, manager, services))
  monitor.addDefaultTasks() // tracks proofs, retries broadcasts
  void monitor.startTasks().catch(e => console.error(`⚠ Wallet monitor (${o.databaseName}) stopped:`, (e as Error).message))
  return new Wallet({ chain, keyDeriver: new CachedKeyDeriver(rootKey), storage: manager, services, monitor })
}

// Spendable satoshis in the wallet's default basket
export async function spendableSats (w: WalletInterface): Promise<number> {
  const { outputs } = await w.listOutputs({ basket: 'default', limit: 10000 })
  return outputs.filter(x => x.spendable).reduce((s, x) => s + x.satoshis, 0)
}

// SPV header source: Arcade's chaintracks (guide §20.3), or the mock chain in offline tests
export async function openChainTracker (): Promise<ChainTracker> {
  if (process.env.MOCK_CHAIN_DB) return (await (await import('../test/helpers/mockchain.js')).openMockChain(process.env.MOCK_CHAIN_DB)).chainTracker
  return new ArcadeChainTracker()
}

// Broadcaster for transactions the proxy builds itself (allowance top-ups): Arcade with Extended Format
export async function openBroadcaster (): Promise<Broadcaster> {
  if (process.env.MOCK_CHAIN_DB) return (await (await import('../test/helpers/mockchain.js')).openMockChain(process.env.MOCK_CHAIN_DB)).broadcaster
  return new ArcadeBroadcaster()
}
