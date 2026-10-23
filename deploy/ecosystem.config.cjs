// Configuration pm2 : lance le proxy, le serveur MCP et la place de marché de démo, et les relance s'ils s'arrêtent.
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
    },
    {
      // Place de marché de démo (boutiques fictives payées en 402) — facultative
      name: 'agentgetpay-market',
      cwd: root,
      script: tsx,
      args: 'src/market/server.ts',
      interpreter: 'node',
      max_memory_restart: '200M',
      time: true
    }
  ]
}
