// Browser stand-in for src/shared/bsv.ts (scripts/build-web.mjs swaps it in when bundling).
// In a browser there is no wallet-toolbox and no CommonJS: the SDK's ESM build is the only copy,
// so the shared allowance code (src/allowance/script.ts, company.ts) can use it directly.
export * from '@bsv/sdk'
