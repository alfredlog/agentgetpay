# Deploy on a VPS (pm2 + Caddy)

Public demo at `https://agentpay.pdf-libre.de` (change the name everywhere if you use another one).
The proxy and the MCP server only listen on `127.0.0.1`; Caddy is the only thing exposed, with HTTPS.

## 1. DNS

At your DNS provider, add an **A record** `agentgetpay` → the VPS IPv4 address (and an **AAAA** record if the VPS has IPv6).

## 2. Code

The repository is private: add a read-only **deploy key** for the VPS.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/agentgetpay_deploy -N ""   # create a key pair for this repo only
cat ~/.ssh/agentgetpay_deploy.pub                            # copy this into GitHub → repo Settings → Deploy keys → Add (read-only)
GIT_SSH_COMMAND="ssh -i ~/.ssh/agentgetpay_deploy" git clone git@github.com:alfredlog/agentgetpay.git ~/apps/agentgetpay
cd ~/apps/agentgetpay
git config core.sshCommand "ssh -i ~/.ssh/agentgetpay_deploy"   # so later `git pull` uses the same key
npm install
```

## 3. Wallet and settings

Create a **new** wallet on the VPS (never copy the `.env` of your laptop), fund it from a testnet faucet, then add the lines of `deploy/env.example` to `.env`:

```bash
npm run wallet      # new wallet + seller secret in .env, prints the address to fund
nano .env           # paste the lines from deploy/env.example
```

Use a **different Telegram bot** than on your laptop: a bot can only be read by one program at a time.

## 4. Start with pm2

```bash
pm2 start deploy/ecosystem.config.cjs   # starts agentgetpay-proxy and agentgetpay-mcp
pm2 save                                # restart them after a reboot
pm2 logs agentgetpay-proxy --lines 20   # note the admin password printed on first start (also in .env)
```

## 5. Caddy

Add the block from `deploy/Caddyfile.example` to `/etc/caddy/Caddyfile`, then:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile   # check the file
sudo systemctl reload caddy                         # apply it; the HTTPS certificate is obtained automatically
```

## 6. Agents

Demo keys (`dev-…`) are refused in public mode. Open `https://agentpay.pdf-libre.de/admin.html`, sign in with the admin password, and click **New API key** for each agent you use.

To let someone else **view** the dashboard (your accountant, a manager), use **Dashboard access** on the admin page: it creates a read-only access code, shown once, that you can revoke at any time.

## 7. Check

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://agentpay.pdf-libre.de/v1/stats   # 401: the dashboard is private
curl -s -o /dev/null -w "%{http_code}\n" https://agentpay.pdf-libre.de/v1/export/datev   # 401: protected
```

MCP clients connect to `https://agentpay.pdf-libre.de/mcp` with `Authorization: Bearer <agent API key>`.

## Update later

```bash
cd ~/apps/agentgetpay && git pull && npm install && pm2 restart agentgetpay-proxy agentgetpay-mcp
```
