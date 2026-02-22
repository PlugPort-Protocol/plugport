---
id: faq
title: FAQ
sidebar_position: 8
slug: /faq
---

# Frequently Asked Questions

## General

### What is PlugPort?

PlugPort is a MongoDB-compatible document database that stores data on MonadDb's Merkle Patricia Trie. It gives you the MongoDB developer experience with blockchain-grade verifiable storage.

### How is it different from MongoDB?

MongoDB stores data in its WiredTiger storage engine. PlugPort stores data in MonadDb's Merkle Patricia Trie, which means every write produces a cryptographic proof. The API is the same, but the storage guarantees are different.

### Can I use my existing MongoDB code?

Yes. You can connect via the wire protocol with **zero code changes** (just change the URI). Or swap to the PlugPort SDK with a 2-line change. See the [Migration Guide](./migration-guide).

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

Full walkthrough: [MonadDb Integration](./monaddb-integration#production-mode).

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

Not natively. Use the JSON metrics API (/api/v1/metrics) with polling, or the built-in dashboard that auto-refreshes every 3 seconds.

---

## Compatibility

### Which MongoDB features are supported?

See the [Migration Guide compatibility table](./migration-guide#data-format-compatibility). Key supported features: CRUD, single-field indexes, sort, projection, skip/limit, and common query operators.

### What's NOT supported?

Transactions, `$lookup` joins, `$regex`, change streams, text search, compound indexes, and TTL indexes. These are on the roadmap.

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

See the [Deployment Guide](./guides/deployment).

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
