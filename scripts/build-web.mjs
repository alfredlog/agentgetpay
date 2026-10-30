// Bundles the admin page's wallet code (src/web/allowance.ts) into public/allowance.js, without a CDN.
// The shared allowance code imports the SDK from src/shared/bsv.ts (Node: CommonJS build through
// createRequire); in the browser that module is replaced by src/web/bsv-browser.ts (ESM build).
import { build } from 'esbuild' // shipped with tsx
import { fileURLToPath } from 'node:url'

const browserSdk = fileURLToPath(new URL('../src/web/bsv-browser.ts', import.meta.url))
await build({
  entryPoints: [fileURLToPath(new URL('../src/web/allowance.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../public/allowance.js', import.meta.url)),
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none',
  plugins: [{
    name: 'browser-sdk',
    setup (b) { b.onResolve({ filter: /shared\/bsv\.js$/ }, () => ({ path: browserSdk })) }
  }]
})
console.log('public/allowance.js built')
