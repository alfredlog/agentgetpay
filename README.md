# AgentGetPay — spend control for AI agents

Companies want AI agents that can pay for APIs and data on their own, but no finance team will give an agent a wallet without limits. AgentGetPay sits between the agents and the money:

- **Agents never hold keys.** They call the payment proxy with an API key; the proxy holds the wallet.
- **Every payment is checked before it is signed:** daily budget, max per payment, allowed domains.
- **Works with any AI assistant** through an MCP server: the assistant decides what to buy, the company's rules decide what gets paid.
- **Finance manages each agent** from an admin page: budgets, limits, suspension, API keys.
- **A human approves large payments** from their phone (Telegram) or from the dashboard, whichever answers first, and their name is recorded.
- **Finance gets a DATEV export** and a monthly statement, one booking per payment.
- **Every decision is logged** in a hash-chained audit log, **anchored on the BSV blockchain** so anyone can prove it was never altered.
- **Payments are micropayments over HTTP 402**, following [BRC-121](https://github.com/bsv-blockchain/BRCs) (Simple 402 Payments, `@bsv/402-pay`). Merchants publish the order details (merchant, category, items, delivery) through a free quote endpoint (`POST /.well-known/payment-quote`), so the company's rules are applied before anything is paid.

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

Optional, for phone approvals: create a bot with @BotFather on Telegram, add `TELEGRAM_BOT_TOKEN=...` to `.env`, send "hello" to your bot, then run `npm run telegram:setup`. Approvals can always be given on the dashboard too (✅ Approve / ❌ Reject on the waiting request; on a public server, only the administrator sees these buttons). Without Telegram, the dashboard is the only way to approve. A request stays open for 3 days (`APPROVAL_TTL_HOURS`, default 72), then expires. `APPROVAL_AUTO=approved|rejected` answers automatically, for tests.

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

When a payment needs approval, the assistant waits 20 seconds at most; then it gets a request id and continues with other work. It calls `check_request` later to get the result.

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

### Agent allowances: the company's money stays on chain

The company's money does not sit in a server wallet. Each agent spends from its own **allowance**: an on-chain output locked to a script that no single key controls (`src/allowance/script.ts`):

```
OP_IF   <agentPub> OP_CHECKSIGVERIFY <policyPub> OP_CHECKSIG     agent AND proxy policy
OP_ELSE <companyPub> OP_CHECKSIG                                 the company alone
OP_ENDIF
```

- `companyPub` is a derived key of the company's BSV Desktop wallet (protocol `[1, 'agentgetpay allowance']`, key `agent-<agentId>`), never its identity key. `policyPub` belongs to the proxy's policy wallet (`POLICY_ROOT_KEY`, created once in `.env`). `agentPub` belongs to the agent's own wallet, which also pays merchants (BRC-121).
- **Funding:** on the admin page, enter an amount and click **Fund from BSV Desktop**. BSV Desktop creates the output; the proxy checks the script and the amount, verifies the transaction by SPV (Arcade headers) and stores it in `data/allowances.json`. The page's wallet code is bundled with `npm run build:web` into `public/allowance.js` (no CDN).
- **Spending, just in time:** only after a purchase passes the policy (and a human approval if needed), the proxy spends the allowance: a BRC-29 payment of the price plus a small fee buffer to the agent's wallet, change back to the same script. Agent and policy both sign; the transaction goes out through Arcade (Extended Format); the agent's wallet then pays the merchant with BRC-121. If the allowance is too small, the purchase is refused: *allowance empty: ask the company to top up*.
- **Reclaim:** **Reclaim to BSV Desktop** spends the whole allowance back into the company's wallet with the company key alone; the proxy marks it closed.
- The dashboard shows each agent's allowance; funding, top-ups and reclaims are in the audit log with their transaction ids. Test: `npm run test:allowance`.

> **Limitation of this version:** the agent's signing key (`AgentSigner`, `src/allowance/agent-signer.ts`) still runs inside the proxy process, with one key file and one wallet per agent under `data/agents/`. Whoever controls the proxy host can therefore use both the agent key and the policy key. A later version moves the agent signer to the agent side (MCP server), so that the proxy alone can no longer spend an allowance. The company's reclaim key is never on the server.

### Purchase policy (services, travel, goods)

Merchants can describe what they sell in the 402 offer (`extensions.order`: merchant, category, items with unit prices, delivery address). AgentGetPay then applies the company's purchase policy before paying, like a purchasing department would:

- **Daily and monthly budgets** per agent.
- **Purchase categories** (`travel.hotel`, `office.supplies`, `software.subscription`…): if an agent has categories, it can only buy in those. Each category can have a **maximum price per unit** (e.g. €150 per hotel night), a **monthly budget** and its own **approval threshold**. A rule on `travel` also covers `travel.hotel`.
- **Delivery addresses**: goods can only be shipped to the company's addresses (written variants such as "Leopoldstr." / "Leopoldstraße" or "Muenchen" / "München" are recognised).
- The order (merchant, category, items) is stored in the audit log and shown on the dashboard.

Everything is set on the admin page under **Purchase rules**. A **demo market** (`npm run market`) runs fictional shops agents can buy from (hotels in Munich, office supplies with delivery, software subscriptions), with free catalogs at `/api`, paid orders, and a storefront that lists the latest orders paid by agents. It is built with the **seller kit** (`src/shared/seller-kit.ts`): any Express API can charge agents in a few lines. Test: `npm run test:market`. The demo seller (`npm run seller`) includes three fictional shops that describe their orders: a hotel (`/api/hotel/book`), office supplies (`/api/office/order`) and a software subscription (`/api/software/subscribe`). Test: `npm run test:purchase`.

### Long approvals, refunds and mandates

**Approvals can take hours or days.** When a purchase needs a human, the agent waits a few seconds at most (`waitSeconds` on `/v1/fetch`, 0–120, default 120). If nobody has answered yet, it receives `202 pending_approval` with a request id (`R-…`) and continues its work. The request is stored and survives restarts. When someone approves it (Telegram or dashboard, even days later), the proxy **makes the purchase by itself**, never paying more than the approved amount and re-checking budgets and rules, then keeps the result for the agent: `GET /v1/requests/:id` and `GET /v1/requests/:id/result`. An agent can give a `callbackUrl` (on one of its allowed domains) to be notified. Requests with no answer expire after `APPROVAL_TTL_HOURS` (default 72). Assistants use the MCP tools `check_request` and `list_requests`.

**Refunds.** A merchant can cancel and pay back in BSV: the seller kit's `refund()` sends a BRC-29 payment to the buyer's identity key (the sender of the original BRC-121 payment) and returns it in the `refund` field of its JSON answer. The proxy checks that it refers to one of its payments and does not exceed it, verifies and internalizes it in the payer wallet, records a `refund` entry in the audit log, gives the budget back, and books it as a credit (H) in the DATEV export. The demo market supports cancellations (`POST /api/cancel`): hotels until the day before check-in, office supplies within one hour.

**Mandates (standing approvals).** For recurring purchases, an agent asks once (`POST /v1/mandates`, MCP tool `request_mandate`): one merchant, optionally one category, a maximum per month, a duration. Once a human approves, matching payments no longer wait for approval; budgets, categories and other rules still apply, and anything beyond the monthly maximum needs approval again. Mandates are listed on the admin page and can be revoked at any time.

Test: `npm run test:approval` (requests that survive a restart, background execution, callback, rejection, expiry, refund and DATEV credit, mandate).

### Card rail (simulated): merchants that do not accept BSV

Hotels, airlines and most shops are paid by card. The card rail puts them under the **same rules, approvals and audit log** as BSV payments, without ever giving an agent the company's real card:

1. The agent asks for a **single-use virtual card** (`POST /v1/cards`, MCP tool `request_virtual_card`): merchant, domain, category, amount, items, purpose, optional tolerance (up to 20 %, e.g. a hotel that holds a bit more) and validity (up to 60 days).
2. The purchase policy applies (domains, categories, price per unit, budgets, max per payment on the card limit). Above the approval threshold, a human approves on Telegram or the dashboard, even days later. The card details can then be fetched **once**.
3. The card limit is **held on the budget** as soon as the card is issued.
4. When the merchant charges the card, the card network asks AgentGetPay **in real time**. A charge is approved only if it matches: right merchant, right merchant category (MCC, e.g. 7011 = hotel), within the limit, card still open, agent active. Re-using the card, using it elsewhere or for more is **declined on the spot**, and the attempt is recorded.
5. The real amount replaces the hold. The payment goes into the hash-chained audit log (anchored on BSV) and into the DATEV export, with the card authorization id as the voucher reference.

**The company chooses how each agent pays** (admin page, per agent): BSV (HTTP 402) and/or virtual cards. The default is BSV only; cards must be enabled explicitly, can be limited to some categories (e.g. `travel`), and with **BSV first** (on by default) a card is refused for a merchant that accepts BSV (listed with `accepts` in `config/services.json`, or already paid in BSV). An agent can also be card-only. The AI does not decide: it is told its allowed methods by `check_budget`, and the proxy enforces them.

Card numbers are never stored, only hashes and the last 4 digits. Unused cards expire or can be cancelled on the admin page (**Virtual cards**), which releases the hold.

In this version the issuer and the card network are **simulated** (`src/card/issuer.ts`, `POST /v1/card-network/authorize`, test numbers starting with 4000 00). The demo market accepts these cards on every shop (`"card": {...}` in the order body). For real use, implement `CardIssuer` with an issuing platform (for example Stripe Issuing) and route its real-time authorization webhook to `cardRail.authorize()`; nothing else changes. Test: `npm run test:card`.

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

## Run with Docker

The quickest way for a teammate to run everything on their own computer. Only Docker Desktop is required, no Node.js.

```bash
git clone https://github.com/alfredlog/agentgetpay.git
cd agentgetpay
docker compose up -d --build      # builds the image and starts proxy, MCP server and demo market
docker compose logs -f            # shows the new wallet address (Ctrl+C to leave the logs)
```

On first start the container creates a **new** testnet wallet and all secrets in `docker-data/.env`. Each person gets their own wallet: never copy someone else's `.env`, and never share `docker-data/`.

- Dashboard: http://localhost:5050. Admin page: http://localhost:5050/admin.html, with the password `ADMIN_TOKEN` from `docker-data/.env`.
- MCP server: http://localhost:5070/mcp. For Claude Code: `claude mcp add --transport http agentgetpay http://localhost:5070/mcp`
- Demo market: http://localhost:5080
- Fund the wallet with a testnet faucet, then check it: `docker compose exec agentgetpay npm run balance`
- Optional: a Telegram bot for approvals. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to `docker-data/.env` (use your own bot), then `docker compose restart`.
- Front-end work: `public/index.html` (dashboard) and `public/admin.html` are read live from your folder, so edit them and reload the browser, no rebuild needed. To see them as on the server (login gate, private dashboard), add `PROXY_PUBLIC=true` to `docker-data/.env` and run `docker compose restart`; remove the line to go back to local mode.
- Update: `git pull && docker compose up -d --build`. Stop: `docker compose down` (your data in `docker-data/` stays).

The ports are published on `127.0.0.1` only, so the proxy stays private to that computer (`PROXY_PUBLIC=false` keeps local mode even though it listens on `0.0.0.0` inside the container).

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
| `npm run market` | Demo market: fictional shops paid by agents (port 5080) |
| `npm run test:market` | Test the demo market through the proxy, offline |
| `npm run test:card` | Test the simulated card rail (virtual cards, real-time authorization), offline |
| `npm run test:approval` | Test long approvals, refunds and mandates, offline |
| `npm run build:web` | Bundle the admin page's BSV Desktop code into `public/allowance.js` |
| `npm run test:allowance` | Test agent allowances (funding, top-up, keys alone cannot spend, reclaim), offline |
| `npm run test:purchase` | Test the purchase policy (budgets, categories, delivery addresses), offline |
| `npm run test:local`, `npm run test:proxy` | Offline tests with a fake wallet |

Code comments are in French.
