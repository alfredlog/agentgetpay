// Which BSV network the whole project runs on: BSV_NETWORK=main | test (default: test).
// It drives addresses, the Arcade URL, the x402 network name and explorer links.
// Read lazily (functions, not constants) so that a .env loaded after this module still counts.
export type BsvNetwork = 'main' | 'test'

export function bsvNetwork(): BsvNetwork {
  const n = (process.env.BSV_NETWORK ?? 'test').trim().toLowerCase()
  if (n === 'main' || n === 'test') return n
  throw new Error(`BSV_NETWORK must be "main" or "test" (got "${process.env.BSV_NETWORK}")`)
}

// Address prefix for PrivateKey.toAddress()
export const addressNetwork = () => (bsvNetwork() === 'main' ? 'mainnet' : 'testnet')

// Network name in x402 payment requirements
export const x402Network = () => (bsvNetwork() === 'main' ? 'bsv:mainnet' : 'bsv:testnet')

// WhatsOnChain: explorer links, plus the address index (UTXOs) and raw transactions, which Arcade does not serve
export const wocExplorer = () => (bsvNetwork() === 'main' ? 'https://whatsonchain.com' : 'https://test.whatsonchain.com')
export const wocApi = () => `https://api.whatsonchain.com/v1/bsv/${bsvNetwork()}`
export const explorerTx = (txid: string) => `${wocExplorer()}/tx/${txid}`
export const explorerAddress = (address: string) => `${wocExplorer()}/address/${address}`
