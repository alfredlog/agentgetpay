/**
 * Offline test harness: wallet-toolbox's mock chain plus real wallet-toolbox
 * wallets (the same wallet engine BSV Desktop runs). Adapted from
 * starter/bsv21-token-kit/test/helpers/mockchain.ts (guide Appendix A).
 *
 * Difference with the kit: the chain lives in a SQLite FILE (not in memory), so the
 * proxy, the merchants and the test runner — separate processes — share one chain.
 * The test runner prepares it before starting the processes (prepareMockChain).
 *
 * Two MockServices behaviours (wallet-toolbox 2.14.9) differ from a real
 * broadcaster and are patched here, test-only:
 *  1. Re-broadcasting a transaction the network already has is a success on
 *     ARC/Arcade ("already known"); MockServices treats it as a double spend
 *     of its own inputs. A recipient's wallet re-broadcasts on internalizeAction.
 *  2. hydrateInputSourcesFromBeef parses a fresh Transaction per input but marks
 *     parents visited by txid, so a tx spending two outputs of the same parent
 *     leaves the second copy without its own sources and script verification
 *     fails. Fixed by sharing one Transaction instance per txid.
 */
import { createRequire } from 'node:module'
import type * as Toolbox from '@bsv/wallet-toolbox' with { 'resolution-mode': 'require' }
import type { Knex } from 'knex'
import { Beef, CachedKeyDeriver, MerklePath, PrivateKey, Script, Transaction, type Broadcaster, type ChainTracker, type WalletInterface } from '../../shared/bsv.js'

const require = createRequire(import.meta.url)
const { MockServices, ScriptTemplateBRC29, StorageKnex, Wallet, WalletStorageManager, randomBytesBase64 }: typeof Toolbox = require('@bsv/wallet-toolbox')
const { knex: makeKnex }: typeof import('knex') = require('knex')

type MockServicesT = InstanceType<typeof MockServices>
type WalletT = InstanceType<typeof Wallet>

// One connection per process; WAL and a busy timeout let several processes share the file
export const sqliteKnex = (filename: string): Knex => makeKnex({
  client: 'better-sqlite3',
  connection: { filename },
  useNullAsDefault: true,
  pool: {
    min: 1, max: 1,
    afterCreate: (conn: { pragma: (s: string) => unknown }, done: (err: Error | null, conn: unknown) => void) => {
      conn.pragma('journal_mode = WAL'); conn.pragma('busy_timeout = 15000'); done(null, conn)
    }
  }
})

export interface MockChain {
  services: MockServicesT
  chainTracker: ChainTracker
  broadcaster: Broadcaster // posts a transaction (with its BEEF ancestry) to the mock chain
  makeWallet: (rootKey?: PrivateKey, storageFile?: string) => Promise<WalletT>
  fund: (wallet: WalletInterface, satoshis?: number) => Promise<void>
  mineBlock: () => Promise<void>
  close: () => Promise<void>
}

const opened = new Map<string, Promise<MockChain>>()

/** Test runner: create the chain file and mine mature coinbases, BEFORE starting the processes. */
export async function prepareMockChain (filename: string): Promise<void> {
  const chain = await openMockChain(filename)
  while ((await chain.services.getHeight()) < 110) await chain.mineBlock()
  await chain.close()
  opened.delete(filename)
}

export function openMockChain (filename = ':memory:'): Promise<MockChain> {
  let p = opened.get(filename)
  if (!p) { p = createMockChain(filename); opened.set(filename, p) }
  return p
}

async function createMockChain (filename: string): Promise<MockChain> {
  const chainDb = sqliteKnex(filename)
  const services = new MockServices(chainDb)
  await services.initialize()
  if (filename === ':memory:') for (let i = 0; i < 110; i++) await services.mineBlock()

  const anyServices = services as any
  const postBeef = services.postBeef.bind(services)
  anyServices.postBeef = async (beef: Beef, txids: string[]) => {
    const results = []
    for (const txid of txids) {
      const known = await anyServices.storage.getTransaction(txid)
      results.push(known != null
        ? { name: 'MockServices', status: 'success', txidResults: [{ txid, status: 'success', alreadyKnown: true }] }
        : (await postBeef(beef, [txid]))[0])
    }
    return results
  }
  anyServices.hydrateInputSourcesFromBeef = (tx: Transaction, beef: Beef) => {
    const cache = new Map<string, Transaction>()
    const walk = (t: Transaction): void => {
      for (const input of t.inputs) {
        if (input.sourceTransaction !== undefined || input.sourceTXID === undefined) continue
        let source = cache.get(input.sourceTXID)
        if (source === undefined) {
          const raw = beef.findTxid(input.sourceTXID)?.rawTx
          if (raw === undefined) continue
          source = Transaction.fromBinary(Array.from(raw))
          cache.set(input.sourceTXID, source)
          walk(source)
        }
        input.sourceTransaction = source
      }
    }
    walk(tx)
  }

  const cleanups: Array<() => Promise<void>> = []

  async function makeWallet (rootKey = PrivateKey.fromRandom(), storageFile = ':memory:'): Promise<WalletT> {
    const db = sqliteKnex(storageFile)
    const identityKey = rootKey.toPublicKey().toString()
    const provider = new StorageKnex({ chain: 'mock', knex: db, commissionSatoshis: 0, feeModel: { model: 'sat/kb', value: 100 } } as any)
    await provider.migrate('agentgetpay-test', identityKey)
    await provider.makeAvailable()
    const storage = new WalletStorageManager(identityKey, provider)
    await storage.makeAvailable()
    storage.setServices(services as any)
    const wallet = new Wallet({ chain: 'mock', keyDeriver: new CachedKeyDeriver(rootKey), storage, services, actionBatchMode: 'legacy' } as any)
    cleanups.push(async () => { await wallet.destroy(); await db.destroy() })
    return wallet
  }

  /** Fund a wallet from a mature mock-chain coinbase (pattern from wallet-toolbox's own tests). */
  async function fund (w: WalletInterface, satoshis = 1_000_000): Promise<void> {
    const wallet = w as WalletT
    const height = await services.getHeight()
    const [utxo] = await anyServices.storage.knex('mockchain_utxos')
      .where({ isCoinbase: true, spentByTxid: null }).where('blockHeight', '<=', height - 100).orderBy('blockHeight', 'asc').limit(1)
    const sourceRawTx = Array.from((await anyServices.storage.getTransaction(utxo.txid)).rawTx as number[])
    const derivationPrefix = randomBytesBase64(16)
    const derivationSuffix = randomBytesBase64(16)
    const keys = wallet.getClientChangeKeyPair()
    const template = new ScriptTemplateBRC29({ derivationPrefix, derivationSuffix, keyDeriver: wallet.keyDeriver } as any)
    const payment = new Transaction()
    payment.addInput({ sourceTransaction: Transaction.fromBinary(sourceRawTx), sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff })
    payment.addOutput({ satoshis, lockingScript: template.lock(keys.privateKey, keys.publicKey) })
    const txid = payment.id('hex')
    const sourceProof = (await services.getMerklePath(utxo.txid)).merklePath as MerklePath
    const unproven = new Beef()
    unproven.mergeRawTx(sourceRawTx, unproven.mergeBump(sourceProof))
    unproven.mergeRawTx(payment.toBinary())
    await services.postBeef(unproven as any, [txid])
    await services.mineBlock()
    const beef = new Beef()
    beef.mergeRawTx(payment.toBinary(), beef.mergeBump((await services.getMerklePath(txid)).merklePath as MerklePath))
    await wallet.internalizeAction({
      tx: beef.toBinaryAtomic(txid),
      outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: wallet.identityKey } }],
      description: 'Fund test wallet'
    })
  }

  const broadcaster: Broadcaster = {
    broadcast: async (tx: Transaction) => {
      const txid = tx.id('hex')
      const [r] = await anyServices.postBeef(Beef.fromBinary(tx.toBEEF()), [txid])
      return r?.status === 'success'
        ? { status: 'success', txid, message: 'mock chain' }
        : { status: 'error', code: 'MOCK', txid, description: String(r?.error?.message ?? 'rejected by the mock chain') }
    }
  }

  return {
    services,
    chainTracker: await services.getChainTracker() as unknown as ChainTracker,
    broadcaster,
    makeWallet,
    fund,
    mineBlock: async () => { await services.mineBlock() },
    close: async () => {
      for (const c of cleanups.reverse()) await c()
      await chainDb.destroy()
    }
  }
}
