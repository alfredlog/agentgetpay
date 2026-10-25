#!/usr/bin/env bash
# Container entry point: prepares /app/state, creates the wallet on first start,
# then runs the proxy, the MCP server and the demo market. If one of them stops, the container
# stops too, and Docker restarts it (restart: unless-stopped).
set -euo pipefail
cd /app

STATE=/app/state
mkdir -p "$STATE/config" "$STATE/data" "$STATE/workspace"
touch "$STATE/.env"

# Copy the default rules once; services.json is part of the code, so it is refreshed on every start
for file in config.defaults/*.json; do
  name=$(basename "$file")
  if [ "$name" = "services.json" ] || [ ! -f "$STATE/config/$name" ]; then
    cp "$file" "$STATE/config/$name"
  fi
done

TSX=node_modules/.bin/tsx

# First start: create a NEW testnet wallet and the seller secret in .env
if ! grep -q '^BSV_WIF=' "$STATE/.env"; then
  $TSX src/create-wallet.ts
fi

pids=()
stop() { kill "${pids[@]}" 2>/dev/null || true; }
trap stop TERM INT

$TSX src/proxy/server.ts & pids+=($!)

# The proxy writes ADMIN_TOKEN and CARD_NETWORK_KEY into .env on its first start.
# Start the market only once the proxy answers, so it reads the card network key.
for _ in $(seq 1 60); do
  if node -e "fetch('http://127.0.0.1:${PROXY_PORT:-5050}/v1/session').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; then
    break
  fi
  sleep 1
done

$TSX src/mcp/server.ts & pids+=($!)
$TSX src/market/server.ts & pids+=($!)

echo "AgentGetPay is running:"
echo "  Dashboard     http://localhost:5050   (admin page: /admin.html, password = ADMIN_TOKEN in docker-data/.env)"
echo "  MCP server    http://localhost:5070/mcp"
echo "  Demo market   http://localhost:5080"

# Exit as soon as one process stops; Docker then restarts the whole container
wait -n "${pids[@]}"
code=$?
stop
exit "$code"
