# AgentGetPay — spend control for AI agents

Companies want AI agents that can pay for APIs and data on their own, but no finance team will give an agent a wallet without limits. AgentGetPay sits between the agents and the money:

- **Agents never hold keys.** They call the payment proxy with an API key; the proxy holds the wallet.
- **Every payment is checked before it is signed:** daily budget, max per payment, allowed domains.
- **Works with any AI assistant** through an MCP server: the assistant decides what to buy, the company's rules decide what gets paid.
- **Finance manages each agent** from an admin page: budgets, limits, suspension, API keys.
- **A human approves large payments** from their phone (Telegram) or from the dashboard, whichever answers first, and their name is recorded.
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

Optional, for phone approvals: create a bot with @BotFather on Telegram, add `TELEGRAM_BOT_TOKEN=...` to `.env`, send "hello" to your bot, then run `npm run telegram:setup`. Approvals can always be given on the dashboard too (✅ Approve / ❌ Reject on the waiting request; on a public server, only the administrator sees these buttons). Without Telegram, the dashboard is the only way to approve; a request with no answer after 2 minutes is refused. `APPROVAL_AUTO=approved|rejected` answers automatically, for tests.

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

### Use it from any AI assistant (MCP)

AgentGetPay ships an [MCP](https://modelcontextprotocol.io) server, so any MCP-compatible assistant or agent framework (Claude, ChatGPT, Copilot, Cursor, Gemini CLI, OpenAI Agents SDK, LangChain…) can buy services within the company's rules. The assistant never holds a wallet key: every call goes through the proxy.

| Tool | What it does |
| --- | --- |
| `check_budget` | The agent's rules, what it can still spend today, its last 10 operations |
| `get_price` | Asks a service for its price **without paying**, and says whether the rules would allow, refuse or require approval |
| `pay_and_fetch` | Calls a service; if it asks for payment, the proxy checks the rules, may ask a human, pays and returns the result. A `purpose` is required for the audit log |
| `list_workspace_files` | Files the agent can send, and files it received |

**Local mode (stdio)**, for desktop assistants:

```bash
npm run mcp:config              # prints the configuration to paste, with the exact paths of this computer
npm run mcp:config -- <api-key> # same, for an agent whose key was issued on the admin page
```

**HTTP mode**, for several agents sharing one server: `npm run mcp:http`, then connect to `http://127.0.0.1:5070/mcp` with `Authorization: Bearer <agent API key>`. Each client acts as its own agent, with its own budget.

**Connect Claude, ChatGPT and other assistants without any key (OAuth).** On the admin page, click **Connect an assistant** on an agent: it shows the connector URL (`https://<your-host>/mcp`) and a single-use connection code (valid 15 minutes). In the assistant, add a custom connector with that URL and click **Connect**; on the AgentGetPay page, type the code. The assistant then spends within that agent's budget and rules. The admin page lists connected assistants and can disconnect them at any time; connections are recorded in the audit log.

Under the hood: OAuth 2.1 with discovery (RFC 9728, RFC 8414), dynamic client registration (RFC 7591), mandatory PKCE (S256), 1-hour access tokens, rotating refresh tokens, hashed storage, 10 wrong codes per 15 minutes per IP. Test: `npm run test:oauth` (uses the official MCP client).

**Files with a remote assistant.** A connected assistant cannot read files from the user's computer. When a file is needed, it calls `request_file_upload` and gives the user a private link (valid 15 minutes) to drop the file; every file it produces comes with a private download link (valid 24 hours). Each agent has its own folder; files are limited to 25 MB each and 200 MB per agent (`MCP_MAX_FILE_MB`, `MCP_MAX_WORKSPACE_MB`). Test: `npm run test:files`.

**Files:** the assistant only sees the `workspace/` folder. In a request body, `{"$file": "invoice.pdf"}` is replaced by the file's content; files received (for example a compressed PDF) are saved in `workspace/out/`. Paths outside the folder and symbolic links pointing outside are refused.

Payments above the approval threshold wait up to 2 minutes for the human; some assistants stop waiting for a tool earlier.

### Prove the audit log on the blockchain

```bash
npm run anchor          # anchor the latest entries on BSV now
npm run ledger:verify   # check the log against the blockchain → AUDIT LOG INTACT
npm run demo:tamper     # a "smart" attacker edits entry #2 and recomputes every hash
npm run ledger:verify   # local chain looks fine, BSV anchor does not → AUDIT LOG TAMPERED
```

### Manage agents (admin page)

Open **http://localhost:5050/admin.html** (or **Manage agents** on the dashboard). Sign in with your name and the admin password: `ADMIN_TOKEN` in `.env`, created automatically the first time the proxy starts.

For each agent you can change the daily budget, the maximum per payment, the approval threshold and the allowed domains, suspend or reactivate it, reset today's spending, and issue a new API key (the old one stops working). You can also create new agents. Changes apply immediately, without restarting the proxy.

Every change is written to the audit log with the name of the person who made it, and sealed on BSV like the payments. New API keys are shown once and only their hash is stored.

### Accounting export (DATEV)

German accountants work in DATEV. Every paid entry becomes one booking, with the audit log entry as voucher number (`AGP-<n>`) and the BSV transaction as reference.

```bash
npm run export:datev            # this month → data/exports/EXTF_Buchungsstapel_AgentGetPay_YYYY-MM.csv
npm run export:datev -- 2026-10 # a given month
```

The dashboard also has **Export DATEV** and **Monthly statement** buttons. The statement is a printable voucher listing every payment, who approved it, and the blockchain anchor that seals it.

Accounts, consultant and client numbers are in `config/accounting.json` (SKR03 examples). The file is a simplified *Buchungsstapel* with the 14 main columns: validate it with a tax advisor and a test import in DATEV before real use. Network fees are not booked yet.

Daily spending is rebuilt from the audit log when the proxy starts, so restarting it does not reset budgets. To reset an agent's spending (for example between demo rehearsals), use **Reset today's spending** on the admin page.

## Security

- **Allowed domains apply to every request**, paid or free. Agents cannot call other domains, non-HTTP URLs, or the proxy itself, and redirects are never followed.
- **The proxy only listens on this computer** (`127.0.0.1`). To open it to the network (for example for a teammate), set `PROXY_HOST=0.0.0.0` in `.env`: the dashboard and exports then require the admin password, and the demo keys (`dev-…`, published in this repo) stop working. Issue new keys on the admin page.
- The seller listens on this computer too (`SELLER_HOST` to change it).

## Deploy on a server

`deploy/` contains a pm2 configuration, a Caddy block and a step-by-step guide: [deploy/DEPLOY.md](deploy/DEPLOY.md). Behind Caddy, set `PROXY_PUBLIC=true` so the proxy knows it is public even though it listens on `127.0.0.1`. In public mode the dashboard is private: only the administrator and the people they authorise can open it. The admin page creates read-only **access codes** (`agv_…`, shown once, stored hashed, revocable); they allow viewing the dashboard and downloading the exports, but not changing agents or anchoring. Every grant and revocation is recorded in the audit log. `DASHBOARD_PUBLIC_READ=true` makes the dashboard readable by anyone, for a public demo.

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
| `npm run mcp` / `npm run mcp:http` | MCP server for AI assistants (local / HTTP on port 5070) |
| `npm run mcp:config` | Print the MCP configuration to paste into an assistant |
| `npm run test:oauth` | Test the OAuth connection of assistants, offline |
| `npm run test:files` | Test upload and download links for remote assistants, offline |
| `npm run test:local`, `npm run test:proxy` | Offline tests with a fake wallet |

Code comments are in French.
