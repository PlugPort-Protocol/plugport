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
| `API_KEY` | `string` | none | API key for HTTP auth (disabled if not set) |
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

When `API_KEY` is set, all HTTP requests must include the key:

```bash
# Header
curl -H "x-api-key: your-key" http://localhost:8080/api/v1/collections

# Query parameter
curl http://localhost:8080/api/v1/collections?apiKey=your-key
```

Endpoints exempt from auth: `/health`, `/metrics`

The wire protocol uses SCRAM authentication (placeholder - accepts any credentials in MVP).
