// pm2 configuration: starts the proxy, the MCP server and the demo market, and restarts them if they stop.
// Usage on the VPS: pm2 start deploy/ecosystem.config.cjs && pm2 save
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
      time: true // timestamps in the pm2 logs
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
      // Demo market (fictional shops paid with 402) — optional
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
