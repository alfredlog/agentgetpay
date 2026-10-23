// Asks the proxy to anchor the audit log on BSV right now.
const PROXY = process.env.PROXY_URL ?? 'http://localhost:5050'
const res = await fetch(`${PROXY}/v1/anchor`, { method: 'POST' })
const a = await res.json() as { seq?: number; txid?: string; message?: string; error?: string }
if (!res.ok) console.error('✘ Anchor failed:', a.error)
else if (a.txid) console.log(`⚓ Anchored up to entry #${a.seq}\nhttps://test.whatsonchain.com/tx/${a.txid}`)
else console.log(a.message)
