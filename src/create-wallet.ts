// Creates the secrets in .env (only once): the agent key and the seller secret.
import { PrivateKey } from '@bsv/sdk'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'

const env = existsSync('.env') ? readFileSync('.env', 'utf8') : ''

if (!env.includes('SELLER_SECRET=')) {
  appendFileSync('.env', `SELLER_SECRET=${randomBytes(32).toString('hex')}\n`)
  console.log('Seller secret created.')
}

if (env.includes('BSV_WIF=')) {
  const key = PrivateKey.fromWif(env.match(/BSV_WIF=(\S+)/)![1])
  console.log('Agent key already exists. Address:', key.toAddress('testnet'))
} else {
  const key = PrivateKey.fromRandom()
  appendFileSync('.env', `BSV_WIF=${key.toWif([0xef])}\n`) // 0xef = format testnet
  console.log('Agent wallet created. Address:', key.toAddress('testnet'))
}
console.log('Secrets are stored in .env — never share them.')
