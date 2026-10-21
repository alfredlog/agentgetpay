// Affiche la configuration à coller dans un assistant IA compatible MCP, avec les chemins exacts de cet ordinateur.
// Usage : npm run mcp:config            → agent docs-01 (clé de démo)
//         npm run mcp:config -- <clé>   → avec la clé d'un autre agent (créée sur la page d'administration)
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const key = process.argv[2] ?? 'dev-docs-01'
const root = resolve('.')
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')

const config = {
  mcpServers: {
    agentgetpay: {
      command: process.execPath, // chemin complet de Node.js : les applications ne voient pas toujours ton PATH
      args: [tsxCli, resolve(root, 'src/mcp/server.ts')],
      env: {
        AGENTGETPAY_API_KEY: key,
        AGENTGETPAY_URL: 'http://127.0.0.1:5050',
        MCP_WORKSPACE: resolve(root, 'workspace')
      }
    }
  }
}

console.log('Local mode (stdio): paste this into your assistant\'s MCP configuration')
console.log('(Claude Desktop: Settings → Developer → Edit Config; Cursor: ~/.cursor/mcp.json; VS Code uses "servers" instead of "mcpServers")\n')
console.log(JSON.stringify(config, null, 2))
console.log('\nHTTP mode: run `npm run mcp:http`, then connect your client to http://127.0.0.1:5070/mcp')
console.log(`with the header  Authorization: Bearer ${key}`)
console.log(`\nFiles the assistant can send or receive go in: ${resolve(root, 'workspace')}`)
if (key.startsWith('dev-')) console.log('\nNote: this is a public demo key. For real use, issue a key on the admin page and run: npm run mcp:config -- <key>')
