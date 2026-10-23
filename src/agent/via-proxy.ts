// An agent that goes through the proxy: it has NO wallet key, only an API key.
// Demo scenario: normal calls, then an approval, then refusals.
const PROXY = process.env.PROXY_URL ?? 'http://localhost:5050'
const SELLER = process.env.SELLER_URL ?? 'http://localhost:4000'

async function call(path: string, purpose: string) {
  const res = await fetch(`${PROXY}/v1/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dev-recherche-01' },
    body: JSON.stringify({ url: `${SELLER}${path}`, purpose })
  })
  const text = await res.text()
  let data: unknown
  try { data = JSON.parse(text) } catch { data = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }
  const icon = res.ok ? '✔' : '✘'
  console.log(`${icon} ${path.padEnd(14)} ${res.status}  ${JSON.stringify(data).slice(0, 90)}`)
}

await call('/api/quote', 'Quote for the report')           // €0.10 → allowed
await call('/api/quote', 'Second quote')                  // €0.10 → allowed
await call('/api/analysis', 'Market analysis')               // 0,18 € → validation humaine requise
await call('/api/report', 'Full report')                   // €0.30 → above the maximum
await call('/api/quote', 'Third quote')                 // €0.10 → allowed
await call('/api/quote', 'Fourth quote')                 // €0.10 → allowed
await call('/api/quote', 'Fifth quote')                 // €0.10 → allowed (€0.50)
await call('/api/quote', 'Sixth quote')                   // daily budget exceeded
