---
id: faq
title: FAQ
sidebar_position: 8
---

# Frequently Asked Questions

## General

### What is PlugPort?

PlugPort is a multi-protocol Web3 database that stores data on MonadDb's Merkle Patricia Trie. It gives you the developer experience of traditional databases (MongoDB, PostgreSQL, MySQL, Redis, SQLite) with blockchain-grade verifiable storage.

### How does it interact with existing databases?

PlugPort speaks the native wire protocols of these databases. It processes queries from standard drivers (like `pymongo` or `psycopg2`) and stores the resulting data in MonadDb's Merkle Patricia Trie, meaning every write produces a cryptographic proof. The APIs are the same, but the storage guarantees are verifiable.

### Can I use my existing database code?

Yes. You can connect via your database's native wire protocol with **zero code changes** (just change the connection URI to point to PlugPort). Or swap to the PlugPort SDK. See the [Migration Guide](./migration-guide.md).

---

## Storage & MonadDb

### Do I need MON tokens?

**Development:** No. The in-memory KV store is used by default. No blockchain interaction, no fees.

**Production:** Yes. Write operations (insert, update, delete) submit transactions to MonadDb that require MON for gas. Read operations (find, count) are free RPC calls.

### Do I need to pre-fund an account?

Yes, for production. Three steps:

1. **Generate a keypair:** `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. **Fund the derived address** with MON from the [faucet](https://faucet.monad.xyz) (testnet)
3. **Set env vars:** `MONADDB_ENDPOINT` + `MONADDB_PRIVATE_KEY` (see `.env.example`)

Full walkthrough: [MonadDb Integration](./monaddb-integration.md#production-mode).

### What happens if the wallet runs out of MON?

Write operations will fail with an error. Read operations continue to work since they don't require gas.

### Is data persistent?

- **Dev mode (in-memory):** Data is lost on restart.
- **Production (MonadDb):** Data is permanently stored on the Monad blockchain.

---

## Performance

### How fast is it?

In-memory mode latency is under 5ms for most operations. MonadDb mode depends on network latency and block confirmation times (typically 1 second on Monad).

### How many documents can it store?

In-memory mode: limited by available RAM. MonadDb mode: effectively unlimited (limited by Monad's state storage capacity).

### Does it support real-time queries?

Yes. PlugPort supports real-time messaging via Redis Pub/Sub over Server-Sent Events (SSE). Subscribe to channels with `GET /api/v1/redis/stream?channels=chat,notifications`. The dashboard also auto-refreshes metrics every 3 seconds.

---

## Compatibility

### Which MongoDB features are supported?

See the [Migration Guide compatibility table](./migration-guide.md#data-format-compatibility). Key supported features: CRUD (`insertOne`, `insertMany`, `find`, `findOne`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`), `countDocuments`, `distinct`, single-field indexes, sort, projection, skip/limit, common query operators, and RBAC access control (`grantRole`/`revokeRole`). PlugPort also supports SQL queries and Redis commands via the multi-protocol layer.

### What's NOT supported?

`$regex`, change streams, text search, compound indexes, TTL indexes, and `$group` aggregation. These are on the roadmap. Note: `$lookup` joins and transactions (best-effort) are now supported.

### Can I use mongosh?

Yes. Connect with `mongosh mongodb://localhost:27017` and use standard commands.

### Can I use MongoDB Compass?

Partial support. Compass can connect and browse collections, but some advanced features may not work due to unsupported wire protocol commands.

---

## Deployment

### Where can I deploy for free?

- **Railway**: Server (500 hrs/mo free)
- **Vercel**: Dashboard (unlimited)
- **Docker Hub**: Container images (public)
- **GitHub Actions**: CI/CD (2000 min/mo)

See the [Deployment Guide](./guides/deployment.md).

### Can it run alongside MongoDB?

Yes. Run PlugPort on different ports (e.g., HTTP 8080, Wire 27018) and migrate collections incrementally.

---

## Development

### How do I run the tests?

```bash
# Unit tests
pnpm --filter @plugport/server test

# Integration tests (start server first)
pnpm --filter @plugport/server dev &
pnpm --filter @plugport/tests test:integration
```

### How do I contribute?

Fork the repo, create a feature branch, and submit a PR. The CI pipeline runs lint, unit tests, and integration tests automatically.

### Where are the .env.example files?

Every package has one:

| Package | File | Key Variables |
|---------|------|---------------|
| Root | `.env.example` | All server variables |
| Server | `packages/server/.env.example` | Ports, auth, MonadDb |
| Dashboard | `packages/dashboard/.env.example` | API URL |
| E-commerce | `demos/ecommerce/.env.example` | Server URL, port |
| Chat | `demos/chat/.env.example` | Server URL, port |
