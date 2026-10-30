// Environment for the processes a test runner starts.
//
// @bsv/wallet-toolbox calls dotenv.config() when it is imported, so a runner that loads it
// (directly or through the shared modules) gets the REPOSITORY's .env in process.env. Its
// children would inherit those values, and dotenv in the child does not override inherited
// variables: the test's own .env would be ignored. So every variable the app reads, and every
// key of the repository's .env, is removed; the runner passes what the test needs explicitly.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Every variable the app reads (grep process.env in src), MOCK_CHAIN_DB included: passed explicitly
const APP_VARS = [
  'ADMIN_TOKEN', 'AGENTGETPAY_API_KEY', 'AGENTGETPAY_URL', 'ANCHOR_EVERY', 'APPROVAL_AUTO', 'APPROVAL_AUTO_DELAY_MS',
  'APPROVAL_SWEEP_MS', 'APPROVAL_TTL_HOURS', 'ARCADE_URL', 'BSV_NETWORK', 'BSV_WIF', 'CARD_ISSUER', 'CARD_NETWORK_KEY',
  'CARD_NETWORK_URL', 'DASHBOARD_PUBLIC_READ', 'EUR_PER_SAT', 'MARKET_HOST', 'MARKET_PORT', 'MARKET_PUBLIC_URL',
  'MARKET_SECRET', 'MARKET_WALLET_FILE', 'MCP_ALLOWED_HOSTS', 'MCP_HOST', 'MCP_MAX_FILE_MB', 'MCP_MAX_WORKSPACE_MB',
  'MCP_PORT', 'MCP_PUBLIC_BASE', 'MCP_PUBLIC_URL', 'MCP_SERVICES', 'MCP_TRANSPORT', 'MCP_WORKSPACE', 'MOCK_CHAIN_DB',
  'OAUTH_ISSUER', 'PAYER_ROOT_KEY', 'PAYER_WALLET_FILE', 'POLICY_ROOT_KEY', 'POLICY_WALLET_FILE', 'AGENT_WALLETS_DIR', 'AGENT_ID',
  'ALLOWANCE_FEE_SAT_PER_KB', 'ALLOWANCE_FEE_BUFFER_SATS', 'PDF_LIBRE_URL', 'PROXY_HOST', 'PROXY_PORT', 'PROXY_PUBLIC',
  'PROXY_PUBLIC_HOST', 'PROXY_URL', 'SELLER_HOST', 'SELLER_PORT', 'SELLER_SECRET', 'SELLER_URL', 'SELLER_WALLET_FILE',
  'TELEGRAM_API_BASE', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'
]

// Keys defined in the repository's .env (whatever they are): never inherited by a test process
function repoEnvKeys(): string[] {
  const file = resolve('.env')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').map(l => l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]).filter((k): k is string => !!k)
}

export function childEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of [...APP_VARS, ...repoEnvKeys()]) delete env[k]
  for (const k of Object.keys(env)) if (/^TELEGRAM_/.test(k)) delete env[k]
  return { ...env, ...vars }
}
