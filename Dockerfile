# AgentGetPay in one container: payment proxy (5050), MCP server (5070) and demo market (5080).
# Everything that must survive a restart (.env, rules, ledger, files) lives in /app/state,
# which docker-compose.yml mounts from ./docker-data on the host.
FROM node:22-slim

WORKDIR /app

# Install dependencies first so this layer is cached between code changes
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# The default rules ship in the image; the live copies go to /app/state/config on first start.
# The app reads ./.env, ./config, ./data and ./workspace: point them all into /app/state.
RUN mv config config.defaults \
 && ln -s state/.env .env \
 && ln -s state/config config \
 && ln -s state/data data \
 && ln -s state/workspace workspace \
 && chmod +x docker/start.sh

# Listen on all interfaces inside the container; docker-compose.yml only publishes the ports on the
# host's 127.0.0.1, so the proxy stays private to this computer (PROXY_PUBLIC=false keeps local mode).
ENV PROXY_HOST=0.0.0.0 \
    PROXY_PUBLIC=false \
    MCP_TRANSPORT=http \
    MCP_HOST=0.0.0.0 \
    MARKET_HOST=0.0.0.0

EXPOSE 5050 5070 5080
CMD ["docker/start.sh"]
