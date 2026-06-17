---
id: configuration
title: Configuration
sidebar_label: Configuration
sidebar_position: 5
---

# Configuration

All PlugPort configuration is done via environment variables. No config files are needed.

## Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `HTTP_PORT` | `number` | `8080` | HTTP API port |
| `WIRE_PORT` | `number` | `27017` | Wire protocol port |
| `HOST` | `string` | `0.0.0.0` | Bind address |
| `API_KEY` | `string` | none | Legacy global API key for HTTP auth. Prefer generating wallet-linked keys via Dashboard instead. |
| `JWT_SECRET` | `string` | `default-jwt-secret...` | Secret for signing SIWE JWTs |
| `LOG_LEVEL` | `string` | `info` | `debug`, `info`, `warn`, `error` |
| `METRICS_ENABLED` | `boolean` | `true` | Enable Prometheus /metrics |
| `MONADDB_ENDPOINT` | `string` | none | MonadDb RPC URL (in-memory if not set) |
| `MONADDB_PRIVATE_KEY` | `string` | none | Server wallet private key (64 hex chars, no 0x) |
| `MAX_DOC_SIZE` | `number` | `1048576` | Max document size in bytes |
| `MAX_COLLECTIONS` | `number` | `1000` | Max number of collections |

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
LOG_LEVEL=warn \
METRICS_ENABLED=true \
MONADDB_ENDPOINT=https://monaddb-rpc.monad.xyz/v1 \
MONADDB_PRIVATE_KEY=your_64_char_hex_private_key \
node packages/server/dist/index.js
```

### Docker

```bash
docker run \
  -e HTTP_PORT=8080 \
  -e API_KEY=your-key \
  -e LOG_LEVEL=info \
  -p 8080:8080 \
  plugport/server
```

## Authentication

PlugPort uses a Triple-Auth Middleware for maximum flexibility:

1. **JWT Bearer (SIWE):** For the Dashboard, using Sign-In with Ethereum.
2. **Wallet-Linked API Key:** Generated via the Dashboard (starts with `pp_`). Use as a Bearer token:
   ```bash
   curl -H "Authorization: Bearer pp_test_123..." http://localhost:8080/api/v1/collections
   ```
3. **Legacy API Key (`x-api-key`):** If the `API_KEY` env var is set, it can be passed via the `x-api-key` header or `?apiKey=` query parameter.

Endpoints exempt from auth: `/health`, `/metrics`

The wire protocol uses SCRAM authentication (placeholder - accepts any credentials in MVP).
