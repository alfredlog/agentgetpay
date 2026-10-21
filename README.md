# AgentGetPay — spend control for AI agents

Companies want AI agents that can pay for APIs and data on their own, but no finance team will give an agent a wallet without limits. AgentGetPay sits between the agents and the money:

- **Agents never hold keys.** They call the payment proxy with an API key; the proxy holds the wallet.
- **Every payment is checked before it is signed:** daily budget, max per payment, allowed domains.
- **A human approves large payments** from their phone (Telegram), and their name is recorded.
- **Finance gets a DATEV export** and a monthly statement, one booking per payment.
- **Every decision is logged** in a hash-chained audit log, **anchored on the BSV blockchain** so anyone can prove it was never altered.
- **Payments are micropayments over HTTP 402**, following the [BRC-166](https://github.com/bsv-blockchain/BRCs/blob/master/payments/0166.md) standard (x402 on BSV).

Runs on the BSV **testnet**: the coins have no value.

## Architecture

```
AI agent ──(API key)──▶ Payment proxy ──(HTTP 402 + BSV payment)──▶ Paid API
                          │  rules · budget · human approval
                          │  wallet (key never leaves the proxy)
                          ▼
                 Audit log ──(fingerprint every 5 entries)──▶ BSV blockchain
                          │
                          ▼
                 Live dashboard (http://localhost:5050)
```

Each part sits behind an interface (`src/proxy/types.ts`), so the hackathon version can be swapped for an enterprise one without touching the proxy:

| Interface | Now | Enterprise |
| --- | --- | --- |
| `PolicyEngine` | JSON rules (`config/policies.json`) | Open Policy Agent |
| `BudgetStore` | In memory | Redis |
| `KeyStore` | Key in `.env` | HashiCorp Vault / HSM |
| `ApprovalChannel` | Telegram | Microsoft Teams, two approvers |
| `Ledger` | Hash-chained file + BSV anchors | Postgres + BSV anchors |

## Setup

Requires Node.js 20 or later.

```bash
npm install          # install dependencies
npm run wallet       # create the agent wallet and seller secret in .env
```

Send testnet coins to the address it prints (for example from [scrypt.io/faucet](https://scrypt.io/faucet)), then check:

```bash
npm run balance
```

Optional, for phone approvals: create a bot with @BotFather on Telegram, add `TELEGRAM_BOT_TOKEN=...` to `.env`, send "hello" to your bot, then run `npm run telegram:setup`. Without Telegram, approvals are rejected automatically.

**Never commit or share `.env`**: it holds the wallet key.

## Run the demo

Three terminals:

```bash
npm run seller       # 1. a paid API (10, 18 and 30 sats per call)
npm run proxy        # 2. the payment proxy + dashboard on http://localhost:5050
npm run agent:proxy  # 3. an agent making 8 calls
```

Expected: two quotes paid, the analysis waits for your approval on Telegram, the report is blocked (above the per-payment maximum), and the agent is stopped once its €0.50 daily budget is spent.

### Demo with a real paid service: PDF Libre

[PDF Libre](https://pdf-libre.de) sells PDF compression (20 sats) and merging (30 sats) to agents over HTTP 402. The agent `docs-01` has a €2 daily budget, and needs human approval above €0.25.

1. In the `pdf-tools` repo: `npm install`, add `AGENT_API_ENABLED=true` and `AGENT_PAY_SECRET=<long random string>` to its `.env`, then `npm run dev` (port 3000).
2. Here: `npm run proxy`, then:

```bash
npm run agent:pdf                              # with two generated sample PDFs
npm run agent:pdf -- invoice.pdf contract.pdf  # or with your own files
```

Expected: the compression is paid automatically, the merge waits for your approval on Telegram, and a damaged file is refused by PDF Libre without being charged. Results are saved in `data/out/`.

### Prove the audit log on the blockchain

```bash
npm run anchor          # anchor the latest entries on BSV now
npm run ledger:verify   # check the log against the blockchain → AUDIT LOG INTACT
npm run demo:tamper     # a "smart" attacker edits entry #2 and recomputes every hash
npm run ledger:verify   # local chain looks fine, BSV anchor does not → AUDIT LOG TAMPERED
```

### Accounting export (DATEV)

German accountants work in DATEV. Every paid entry becomes one booking, with the audit log entry as voucher number (`AGP-<n>`) and the BSV transaction as reference.

```bash
npm run export:datev            # this month → data/exports/EXTF_Buchungsstapel_AgentGetPay_YYYY-MM.csv
npm run export:datev -- 2026-10 # a given month
```

The dashboard also has **Export DATEV** and **Monthly statement** buttons. The statement is a printable voucher listing every payment, who approved it, and the blockchain anchor that seals it.

Accounts, consultant and client numbers are in `config/accounting.json` (SKR03 examples). The file is a simplified *Buchungsstapel* with the 14 main columns: validate it with a tax advisor and a test import in DATEV before real use. Network fees are not booked yet.

Restarting the proxy resets the daily budgets (they are kept in memory).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run wallet` | Create the agent key and seller secret in `.env` |
| `npm run balance` | Show the wallet address and balance |
| `npm run send` | Send 100 sats to yourself (first test payment) |
| `npm run seller` | Start the paid API on port 4000 |
| `npm run agent` | One agent paying directly, without the proxy |
| `npm run proxy` | Start the payment proxy and dashboard on port 5050 |
| `npm run agent:proxy` | Run the 8-call demo scenario through the proxy |
| `npm run agent:pdf` | Agent buying PDF compression and merging from PDF Libre |
| `npm run telegram:setup` | Find your Telegram chat id and save it in `.env` |
| `npm run anchor` | Anchor the audit log on BSV now |
| `npm run ledger:verify` | Verify the audit log against the blockchain |
| `npm run demo:tamper` | Tamper with the log (demo only) |
| `npm run export:datev` | Export the month's payments as a DATEV file |
| `npm run test:local`, `npm run test:proxy` | Offline tests with a fake wallet |

Code comments are in French.
