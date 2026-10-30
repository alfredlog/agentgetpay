// The ONLY place that loads @bsv/sdk. Every other file imports the SDK from here.
//
// Why: @bsv/sdk ships two builds (ESM and CommonJS). Our code is ESM, so a plain
// `import ... from '@bsv/sdk'` would load the ESM build, while @bsv/wallet-toolbox
// (CommonJS) `require`s the CJS build. Both would then live in the same process and
// every SDK class would exist twice: a Transaction built by one copy fails
// `instanceof` checks in the other (guide §2 and §23: "script[serializedBytes] is not
// a function"). Loading the CJS build here with `require`, exactly as wallet-toolbox
// does, makes Node's module cache hand both of them the very same objects.
import { createRequire } from 'node:module'
import type * as SDK from '@bsv/sdk' with { 'resolution-mode': 'require' } // types of the CJS build too

const require = createRequire(import.meta.url)
const sdk: typeof SDK = require('@bsv/sdk')

// Values (classes, namespaces) used by the project. Add a name here when you need it.
export const { PrivateKey, PublicKey, Transaction, Beef, P2PKH, LockingScript, UnlockingScript, Script, MerklePath, CachedKeyDeriver, Random, Utils, Hash, OP, Signature, TransactionSignature, SatoshisPerKilobyte } = sdk

// Classes are also types: re-export their instance types under the same names.
export type PrivateKey = SDK.PrivateKey
export type Transaction = SDK.Transaction
export type P2PKH = SDK.P2PKH
export type LockingScript = SDK.LockingScript
export type MerklePath = SDK.MerklePath
export type PublicKey = SDK.PublicKey
export type Beef = SDK.Beef
export type Script = SDK.Script
export type CachedKeyDeriver = SDK.CachedKeyDeriver
export type UnlockingScript = SDK.UnlockingScript
export type ScriptTemplate = SDK.ScriptTemplate
export type ScriptTemplateUnlock = SDK.ScriptTemplateUnlock
export type Broadcaster = SDK.Broadcaster
export type BroadcastResponse = SDK.BroadcastResponse
export type BroadcastFailure = SDK.BroadcastFailure
export type ChainTracker = SDK.ChainTracker
export type WalletInterface = SDK.WalletInterface
export type WalletProtocol = SDK.WalletProtocol

// The CJS module object itself, for checks (see src/test/bsv-flow.ts).
export const sdkModule = sdk
