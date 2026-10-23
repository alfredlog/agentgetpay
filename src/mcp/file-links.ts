// Files in "connector" mode (assistant connected remotely, e.g. Claude on claude.ai).
// The assistant cannot pass on a file from the user's computer. So:
//   - it gives an UPLOAD LINK: the user opens it, picks the PDF, and the file lands in the agent's folder (in/);
//   - for each file it produces (out/), it gives a DOWNLOAD LINK.
// Links are secret and temporary (upload: 15 min, download: 24 h), and each agent has its own folder.
import express from 'express'
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, stat, writeFile, realpath } from 'node:fs/promises'
import { join, relative, basename, extname, resolve, sep } from 'node:path'

const UPLOAD_TTL = 15 * 60_000
const DOWNLOAD_TTL = 24 * 3600_000

interface Link { kind: 'upload' | 'download'; ws: string; file?: string; exp: number; agentId: string }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

// Safe file name: no folder, no special character
export function safeName(name: string) {
  const base = basename(String(name)).normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').replace(/^\.+/, '').slice(0, 80)
  return base || 'file'
}

async function dirSize(dir: string): Promise<number> {
  let total = 0
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, d.name)
    total += d.isDirectory() ? await dirSize(p) : (await stat(p)).size
  }
  return total
}

export class FileLinks {
  private links = new Map<string, Link>()

  constructor(private publicBase: string, private maxFileMb: number, private maxWorkspaceMb: number) {}

  private sweep() { const now = Date.now(); for (const [k, v] of this.links) if (v.exp < now) this.links.delete(k) }
  private add(l: Link) { this.sweep(); const t = randomBytes(24).toString('base64url'); this.links.set(t, l); return t }

  uploadLink(ws: string, agentId: string) {
    const exp = Date.now() + UPLOAD_TTL
    return { url: `${this.publicBase}/files/u/${this.add({ kind: 'upload', ws, exp, agentId })}`, expiresAt: new Date(exp).toISOString() }
  }

  downloadLink(ws: string, file: string, agentId: string) {
    const exp = Date.now() + DOWNLOAD_TTL
    return { url: `${this.publicBase}/files/d/${this.add({ kind: 'download', ws, file, exp, agentId })}`, expiresAt: new Date(exp).toISOString() }
  }

  router(log: (...a: unknown[]) => void) {
    const r = express.Router()
    const secure: express.RequestHandler = (_req, res, next) => {
      res.set('X-Frame-Options', 'DENY').set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer')
        .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
      next()
    }
    r.use('/files', secure)
    const get = (token: string, kind: Link['kind']) => {
      this.sweep()
      const l = this.links.get(token)
      return l && l.kind === kind && l.exp > Date.now() ? l : undefined
    }

    r.get('/files/u/:token', (req, res) => {
      const l = get(req.params.token, 'upload')
      if (!l) return res.status(404).send(page('Link expired', '<p>This upload link has expired. Ask your assistant for a new one.</p>'))
      res.send(uploadPage(l.agentId, this.maxFileMb, Math.round((l.exp - Date.now()) / 60000)))
    })

    r.post('/files/u/:token', express.raw({ type: () => true, limit: `${this.maxFileMb}mb` }), async (req, res) => {
      const l = get(req.params.token, 'upload')
      if (!l) return res.status(404).json({ error: 'This upload link has expired' })
      const buf = req.body as Buffer
      if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Empty file' })
      if ((await dirSize(l.ws)) + buf.length > this.maxWorkspaceMb * 1024 * 1024) return res.status(413).json({ error: `The agent's folder is full (${this.maxWorkspaceMb} MB)` })
      const inDir = join(l.ws, 'in')
      await mkdir(inDir, { recursive: true })
      // Never overwrite: invoice.pdf, invoice-2.pdf, invoice-3.pdf…
      const name = safeName(String(req.query.name ?? 'file'))
      const stem = basename(name, extname(name)), ext = extname(name)
      let file = name
      for (let i = 2; await stat(join(inDir, file)).then(() => true, () => false); i++) file = `${stem}-${i}${ext}`
      await writeFile(join(inDir, file), buf)
      log(`📥 ${l.agentId} received ${file} (${buf.length} bytes)`)
      res.json({ ok: true, file: `in/${file}`, bytes: buf.length })
    })

    r.get('/files/d/:token', async (req, res) => {
      const l = get(req.params.token, 'download')
      if (!l?.file) return res.status(404).send(page('Link expired', '<p>This download link has expired. Ask your assistant for a new one.</p>'))
      const p = resolve(l.ws, l.file)
      try {
        const real = await realpath(p)
        const rel = relative(await realpath(l.ws), real)
        if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) throw new Error('outside')
        if (!(await stat(real)).isFile()) throw new Error('not a file')
        res.download(real, basename(real))
      } catch {
        res.status(404).send(page('File not found', '<p>This file no longer exists.</p>'))
      }
    })
    // File too large: a clear message instead of a technical error
    r.use('/files', ((err, _req, res, next) => {
      if ((err as { type?: string })?.type === 'entity.too.large') return res.status(413).json({ error: `File larger than ${this.maxFileMb} MB` })
      next(err)
    }) as express.ErrorRequestHandler)
    return r
  }
}

function page(title: string, body: string, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · AgentGetPay</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#16181d; --muted:#6b7280; --line:#e5e7eb; --accent:#2f4fd8; --ok:#0f7b4f; --ok-bg:#e7f6ee; --bad:#b42318; --bad-bg:#fdecea; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#171a21; --text:#eceef2; --muted:#9aa1ad; --line:#262b35; --accent:#8ea2ff; --ok:#4ad295; --ok-bg:#12301f; --bad:#ff8a80; --bad-bg:#3a1714; } }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 -apple-system,"Segoe UI",Inter,sans-serif; background:var(--bg); color:var(--text); }
  main { max-width:460px; margin:48px auto; padding:0 16px; }
  .brand { font-weight:650; margin-bottom:16px; } .brand small { display:block; font-weight:400; color:var(--muted); font-size:13px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; }
  h1 { font-size:18px; margin:0 0 6px; } p { color:var(--muted); margin:0 0 14px; font-size:14px; }
  .drop { display:block; border:2px dashed var(--line); border-radius:12px; padding:28px 16px; text-align:center; cursor:pointer; color:var(--muted); }
  .drop.over { border-color:var(--accent); color:var(--accent); }
  .drop b { color:var(--accent); } input[type=file] { display:none; }
  ul { list-style:none; padding:0; margin:14px 0 0; } li { padding:8px 12px; border-radius:8px; margin-top:6px; font-size:14px; }
  li.ok { background:var(--ok-bg); color:var(--ok); } li.bad { background:var(--bad-bg); color:var(--bad); } li.wait { background:var(--bg); color:var(--muted); }
  .done { margin-top:14px; font-size:14px; color:var(--text); }
</style></head><body><main>
<div class="brand">AgentGetPay<small>Spend control for AI agents</small></div>
<div class="card">${body}</div></main>${script}</body></html>`
}

function uploadPage(agentId: string, maxMb: number, minutesLeft: number) {
  return page('Send files to your assistant', `
  <h1>Send files to your assistant</h1>
  <p>The files go to the private folder of agent <b>${esc(agentId)}</b>. Up to ${maxMb} MB per file. This link expires in ${minutesLeft} min.</p>
  <label class="drop" id="drop"><input type="file" id="pick" multiple><b>Choose files</b> or drop them here</label>
  <ul id="list"></ul>
  <div class="done" id="done" hidden>Done. Go back to your assistant and tell it the files are uploaded.</div>`, `
<script>
const list = document.getElementById('list'), drop = document.getElementById('drop')
async function send(files) {
  let ok = 0
  for (const f of files) {
    const li = document.createElement('li'); li.className = 'wait'; li.textContent = f.name + ' — uploading…'; list.appendChild(li)
    try {
      const r = await fetch(location.pathname + '?name=' + encodeURIComponent(f.name), { method: 'POST', body: f })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || ('Error ' + r.status))
      li.className = 'ok'; li.textContent = '✓ ' + j.file + ' (' + Math.round(j.bytes / 1024) + ' KB)'; ok++
    } catch (e) { li.className = 'bad'; li.textContent = '✗ ' + f.name + ': ' + e.message }
  }
  if (ok) document.getElementById('done').hidden = false
}
document.getElementById('pick').onchange = e => send([...e.target.files])
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over') }
drop.ondragleave = () => drop.classList.remove('over')
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); send([...e.dataTransfer.files]) }
</script>`)
}
