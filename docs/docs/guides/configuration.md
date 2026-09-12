---
id: configuration
title: Configuration
sidebar_label: Configuration
sidebar_position: 5
---

# Configuration

All PlugPort configuration is done via environment variables. No config files are needed.

## Environment Variables

### Core Settings

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `HTTP_PORT` | `number` | `8080` | HTTP API port (also accepts `PORT` for PaaS compatibility) |
| `WIRE_PORT` | `number` | `27017` | MongoDB wire protocol port |
| `HOST` | `string` | `0.0.0.0` | Bind address |
| `API_KEY` | `string` | none | Legacy global API key for HTTP auth. Prefer generating wallet-linked keys via Dashboard instead. |
| `DASHBOARD_URL` | `string` | none | Allowed origin for CORS credentials (required in production, e.g. `https://plugport.xyz`). In dev mode, all origins are allowed. |
| `LOG_LEVEL` | `string` | `info` | `debug`, `info`, `warn`, `error` |
| `METRICS_ENABLED` | `boolean` | `true` | Enable Prometheus /metrics |
| `MAX_DOC_SIZE` | `number` | `1048576` | Max document size in bytes |
| `IS_TESTNET` | `boolean` | `true` | Affects API key prefix (`pp_test_` vs `pp_live_`) |

### Protocol Frontends

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MONGODB_ENABLED` | `boolean` | `true` | Enable MongoDB wire protocol |
| `PG_ENABLED` | `boolean` | `false` | Enable PostgreSQL wire protocol |
| `PG_PORT` | `number` | `5432` | PostgreSQL port |
| `MYSQL_ENABLED` | `boolean` | `false` | Enable MySQL wire protocol |
| `MYSQL_PORT` | `number` | `3306` | MySQL port |
| `REDIS_ENABLED` | `boolean` | `false` | Enable Redis RESP protocol |
| `REDIS_PORT` | `number` | `6379` | Redis port |
| `SQL_STATEMENT_TIMEOUT_MS` | `number` | `30000` | Max execution time for SQL queries in ms |

### Monad / MonadDb

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MONAD_RPC_URL` | `string` | none | Monad RPC URL (in-memory storage if not set) |
| `MONAD_PRIVATE_KEY` | `string` | none | Server wallet private key (64 hex chars, no 0x). Also used to derive the session encryption key. |
| `MONAD_CONTRACT_ADDRESS` | `string` | none | Deployed PlugPortStore contract address |
| `MONAD_CHAIN_ID` | `number` | none | Monad chain ID (e.g. `10143` for testnet) |
| `MONAD_WS_URL` | `string` | none | Monad WebSocket URL for real-time event subscriptions |

### Smart Contracts (Optional)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PRIVATE_STORE_CONTRACT` | `string` | none | Deployed PlugPortPrivateStore contract address |
| `WHITELIST_ADDRESSES` | `string` | none | Comma-separated Ethereum addresses for private store whitelist |
| `MESSAGEBROKER_CONTRACT_ADDRESS` | `string` | none | Deployed PlugPortMessageBroker contract address |
| `RELATIONAL_CONTRACT_ADDRESS` | `string` | none | Deployed PlugPortRelational contract for batch JOIN reads |

## Quick Start with .env.example

Every package and demo includes a `.env.example` file:

```bash
# Root project
cp .env.example .env

# Or per-package
cp packages/server/.env.example packages/server/.env
cp packages/dashboard/.env.example packages/dashboard/.env.local
```

## Examples

### Development

```bash
# Minimal - uses all defaults
pnpm --filter @plugport/server dev
```

### Production

```bash
HTTP_PORT=8080 \
WIRE_PORT=27017 \
HOST=0.0.0.0 \
API_KEY=your-production-key \
DASHBOARD_URL=https://plugport.xyz \
LOG_LEVEL=warn \
METRICS_ENABLED=true \
MONAD_RPC_URL=https://testnet-rpc.monad.xyz \
MONAD_PRIVATE_KEY=your_64_char_hex_private_key \
MONAD_CONTRACT_ADDRESS=0xYourDeployedContractAddress \
node packages/server/dist/index.js
```

### Docker

```bash
docker run \
  -e HTTP_PORT=8080 \
  -e API_KEY=your-key \
  -e DASHBOARD_URL=https://plugport.xyz \
  -e LOG_LEVEL=info \
  -p 8080:8080 \
  plugport/server
```

## Authentication

PlugPort uses a Triple-Auth Middleware for maximum flexibility:

1. **Cookie Session (SIWE):** For the Dashboard, using Sign-In with Ethereum. The session is stored in an encrypted httpOnly cookie via `iron-session`. Session encryption is derived from `MONAD_PRIVATE_KEY` — no separate secret is needed.
2. **Wallet-Linked API Key:** Generated via the Dashboard (starts with `pp_`). Use as a Bearer token:
   ```bash
   curl -H "Authorization: Bearer pp_test_123..." http://localhost:8080/api/v1/collections
   ```
3. **Legacy API Key (`x-api-key`):** If the `API_KEY` env var is set, it can be passed via the `x-api-key` header or `?apiKey=` query parameter.

Endpoints exempt from auth: `/health`, `/metrics`

### CSRF Protection

Session-authenticated (SIWE) mutations are protected by a double-submit CSRF cookie. After login, the server sets a `plugport_csrf` cookie (JS-readable). The dashboard automatically reads this cookie and sends it as the `x-csrf-token` header on every POST/PUT/DELETE request. API key users are exempt.

### Rate Limiting

Auth endpoints have stricter per-route rate limits (e.g., `/auth/verify` is limited to 5 requests/min per IP) to prevent brute-force attacks. All other endpoints share a global limit of 100 requests / 10 seconds per IP. See the [HTTP API Reference](../api-reference/http-api.md#rate-limits) for details.

The wire protocol uses SCRAM authentication (placeholder - accepts any credentials in MVP).
