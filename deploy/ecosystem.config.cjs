// Configuration pm2 : lance le proxy et le serveur MCP, et les relance s'ils s'arrêtent.
// Usage sur le VPS : pm2 start deploy/ecosystem.config.cjs && pm2 save
const path = require('node:path')
const root = path.join(__dirname, '..')
const tsx = path.join(root, 'node_modules/tsx/dist/cli.mjs')

module.exports = {
  apps: [
    {
      name: 'agentgetpay-proxy',
      cwd: root,
      script: tsx,
      args: 'src/proxy/server.ts',
      interpreter: 'node',
      max_memory_restart: '300M',
      time: true // horodatage dans les logs pm2
    },
    {
      name: 'agentgetpay-mcp',
      cwd: root,
      script: tsx,
      args: 'src/mcp/server.ts',
      interpreter: 'node',
      env: { MCP_TRANSPORT: 'http' },
      max_memory_restart: '200M',
      time: true
    }
  ]
}
