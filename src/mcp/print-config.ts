// Prints the configuration to paste into an MCP-compatible AI assistant, with the exact paths of this computer.
// Usage: npm run mcp:config                         → agent docs-01 (demo key), local proxy
//         npm run mcp:config -- <key>                → with another agent's key (issued on the admin page)
//         npm run mcp:config -- <key> <address>      → proxy on a server, e.g. https://agentpay.pdf-libre.de
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const key = process.argv[2] ?? 'dev-docs-01'
const proxyUrl = (process.argv[3] ?? process.env.AGENTGETPAY_URL ?? 'http://127.0.0.1:5050').replace(/\/$/, '')
const root = resolve('.')
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')

const config = {
  mcpServers: {
    agentgetpay: {
      command: process.execPath, // full path of Node.js: apps do not always see your PATH
      args: [tsxCli, resolve(root, 'src/mcp/server.ts')],
      env: {
        AGENTGETPAY_API_KEY: key,
        AGENTGETPAY_URL: proxyUrl,
        MCP_WORKSPACE: resolve(root, 'workspace')
      }
    }
  }
}

console.log('Local mode (stdio): paste this into your assistant\'s MCP configuration')
console.log('(Claude Desktop: Settings → Developer → Edit Config; Cursor: ~/.cursor/mcp.json; VS Code uses "servers" instead of "mcpServers")\n')
console.log(JSON.stringify(config, null, 2))
const remote = !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(proxyUrl + '/')
if (remote) console.log(`\nThe MCP server runs on this computer (it reads and saves files here); payments go through ${proxyUrl}.`)
console.log(`\nHTTP mode: connect your client to ${remote ? `${proxyUrl}/mcp` : 'http://127.0.0.1:5070/mcp (after `npm run mcp:http`)'}`)
console.log(`with the header  Authorization: Bearer ${key}`)
console.log(`\nFiles the assistant can send or receive go in: ${resolve(root, 'workspace')}`)
if (key.startsWith('dev-')) console.log('\nNote: this is a public demo key. For real use, issue a key on the admin page and run: npm run mcp:config -- <key>')
