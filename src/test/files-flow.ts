// Test des fichiers en mode connecteur : lien de dépôt, envoi au service, lien de téléchargement,
// et isolation entre agents. Dossier temporaire, faux service gratuit : aucun paiement, rien n'est touché chez toi.
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import http from 'node:http'
import { PrivateKey } from '@bsv/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const PROXY_PORT = 5250, MCP_PORT = 5270, SERVICE_PORT = 5290
const PROXY = `http://127.0.0.1:${PROXY_PORT}`, MCP = `http://127.0.0.1:${MCP_PORT}/mcp`
const root = resolve('.')
const dir = mkdtempSync(join(tmpdir(), 'agentgetpay-files-'))
cpSync(join(root, 'config'), join(dir, 'config'), { recursive: true })
writeFileSync(join(dir, '.env'), `BSV_WIF=${PrivateKey.fromRandom().toWif()}\nADMIN_TOKEN=test-admin-password-123\n`)

// Faux service "PDF" gratuit : renvoie le fichier reçu, comme un outil de compression
const service = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const body = JSON.parse(b || '{}')
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ filename: 'compressed.pdf', pdf: body.pdf }))
  })
}).listen(SERVICE_PORT)

const tsx = createRequire(import.meta.url).resolve('tsx/cli')
const procs: ChildProcess[] = []
const start = (file: string, env: Record<string, string>) => {
  const p = spawn(process.execPath, [tsx, join(root, file)], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
  p.stderr!.on('data', d => { if (/error/i.test(String(d))) process.stderr.write(d) })
  procs.push(p)
}
start('src/proxy/server.ts', { PROXY_PORT: String(PROXY_PORT), MCP_PORT: String(MCP_PORT), TELEGRAM_BOT_TOKEN: '', APPROVAL_AUTO: 'rejected' })
start('src/mcp/server.ts', { MCP_TRANSPORT: 'http', MCP_PORT: String(MCP_PORT), AGENTGETPAY_URL: PROXY, MCP_WORKSPACE: join(dir, 'workspace'), MCP_MAX_FILE_MB: '1' })

let failures = 0
const check = (ok: boolean, label: string) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) failures++ }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const connect = async (key: string) => {
  const c = new Client({ name: 'files-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }))
  return c
}
const text = (r: any) => String(r.content?.[0]?.text ?? '')
const url = (s: string) => s.match(/https?:\/\/\S+/)?.[0] ?? ''

try {
  for (let i = 0; i < 60; i++) { if (await fetch(`${PROXY}/v1/stats`).then(() => fetch(MCP, { method: 'POST' })).then(() => true, () => false)) break; await sleep(250) }
  const docs = await connect('dev-docs-01')
  const tools = (await docs.listTools()).tools.map(t => t.name)
  check(tools.includes('request_file_upload') && tools.includes('get_download_link'), 'Connector mode offers upload and download tools')

  // 1. Lien de dépôt
  const up = url(text(await docs.callTool({ name: 'request_file_upload', arguments: {} })))
  check(up.startsWith(`http://127.0.0.1:${MCP_PORT}/files/u/`), 'Upload link created')
  const pageHtml = await fetch(up).then(r => r.text())
  check(/Send files to your assistant/.test(pageHtml) && /docs-01/.test(pageHtml), 'Upload page opens and names the agent')

  // 2. L'utilisateur dépose un PDF (assez gros pour être renvoyé comme fichier)
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5000, 65)])
  const sent = await fetch(`${up}?name=${encodeURIComponent('../../Facture März.pdf')}`, { method: 'POST', body: pdf }).then(r => r.json())
  check(sent.file === 'in/Facture-Marz.pdf', `File stored with a safe name (${sent.file})`)
  const again = await fetch(`${up}?name=Facture%20März.pdf`, { method: 'POST', body: pdf }).then(r => r.json())
  check(again.file === 'in/Facture-Marz-2.pdf', 'A second file with the same name does not overwrite the first')
  const big = await fetch(`${up}?name=big.pdf`, { method: 'POST', body: Buffer.alloc(2 * 1024 * 1024) })
  check(big.status === 413, 'Files above the size limit are refused')
  check(/in\/Facture-Marz\.pdf/.test(text(await docs.callTool({ name: 'list_workspace_files', arguments: {} }))), 'The assistant sees the uploaded file')

  // 3. Envoi au service, puis lien de téléchargement du résultat
  const r = await docs.callTool({ name: 'pay_and_fetch', arguments: { url: `http://localhost:${SERVICE_PORT}/compress`, method: 'POST', body: { pdf: { $file: 'in/Facture-Marz.pdf' } }, purpose: 'Compress the invoice for the archive' } })
  const dl = text(r).match(/out\/compressed\.pdf: (\S+)/)?.[1] ?? ''
  check(!!dl, 'Result comes with a download link')
  const got = Buffer.from((await (await fetch(dl)).arrayBuffer()) as ArrayBuffer)
  check(got.equals(pdf), 'Download link returns the produced file')

  // 4. Un autre agent ne voit rien et ne peut pas sortir de son dossier
  const other = await connect('dev-recherche-01')
  check(!/Facture/.test(text(await other.callTool({ name: 'list_workspace_files', arguments: {} }))), 'Another agent does not see these files')
  const escape = await other.callTool({ name: 'get_download_link', arguments: { file: '../docs-01/in/Facture-Marz.pdf' } }) as any
  check(escape.isError === true, 'Another agent cannot get a link to these files')
  check((await fetch(`http://127.0.0.1:${MCP_PORT}/files/d/not-a-real-token`)).status === 404, 'Unknown links are refused')
  await docs.close(); await other.close()
} catch (e) {
  console.error(e); failures++
} finally {
  for (const p of procs) p.kill()
  service.close()
  rmSync(dir, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll file checks passed')
process.exit(failures ? 1 : 0)
