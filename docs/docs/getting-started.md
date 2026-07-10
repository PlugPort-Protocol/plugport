---
id: getting-started
title: Getting Started
sidebar_position: 1
slug: /getting-started
---

# Getting Started

PlugPort is a MongoDB-compatible document store backed by MonadDb's Merkle Patricia Trie. This guide will have you up and running in under 5 minutes.

## Prerequisites

- **Node.js** >= 18
- **pnpm** >= 9.0 (or npm/yarn)

## Installation

### Option A: Clone and Run (Full Project)

```bash
git clone https://github.com/plugport/plugport.git
cd plugport
cp .env.example .env       # Configure environment (optional for dev)
pnpm install
pnpm -r build
pnpm --filter @plugport/server dev
```

:::tip
In dev mode, no `.env` config is needed. The server uses in-memory storage with all defaults. Copy `.env.example` only when you want to customize ports, enable auth, or connect to MonadDb.
:::

### Option B: Use the CLI

```bash
npx @plugport/cli playground
```

This starts the server, loads sample data, and creates indexes.

### Option C: Docker

```bash
docker run -p 8080:8080 -p 27017:27017 plugport/server
```

## Verify It Works

```bash
# Health check
curl http://localhost:8080/health

# Insert a document
curl -X POST http://localhost:8080/api/v1/collections/users/insertOne \
  -H "Content-Type: application/json" \
  -d '{"document": {"name": "Alice", "email": "alice@example.com", "age": 30}}'

# Find documents
curl -X POST http://localhost:8080/api/v1/collections/users/find \
  -H "Content-Type: application/json" \
  -d '{"filter": {"name": "Alice"}}'
## Generate an API Key

PlugPort is a multi-tenant platform. To securely connect to the API, you need an API key linked to your wallet.

1. Open the dashboard at `http://localhost:3000` (or the deployed URL).
2. Click **Connect Wallet** and sign the SIWE message.
3. Navigate to the **API Keys** tab.
4. Click **Generate New Key** and copy the `pp_test_...` key.

## Connect with Your Language

### Node.js

```bash
npm install @plugport/sdk
```

```typescript
import { PlugPortClient } from '@plugport/sdk';

const client = await PlugPortClient.connect('http://localhost:8080', {
    apiKey: 'pp_test_1234567890abcdef...',
});
const db = client.db('myapp');
const users = db.collection('users');

await users.insertOne({ name: 'Alice', email: 'alice@example.com' });
const docs = await users.find({ name: 'Alice' });
console.log(docs);

await client.close();
```

### Python

```bash
pip install plugport
```

```python
from plugport import PlugPortClient

client = PlugPortClient("http://localhost:8080", api_key="pp_test_1234567890abcdef...")
db = client["myapp"]
users = db["users"]

users.insert_one({"name": "Alice", "email": "alice@example.com"})
docs = users.find({"name": "Alice"})
```

### Go

```go
import plugport "github.com/plugport/plugport-go"

client, _ := plugport.Connect("http://localhost:8080", plugport.ClientOptions{
    APIKey: "pp_test_1234567890abcdef...",
})
defer client.Close()

coll := client.Database("myapp").Collection("users")
coll.InsertOne(ctx, map[string]interface{}{"name": "Alice"})
```

### mongosh (Wire Protocol)

```bash
mongosh mongodb://localhost:27017

> use myapp
> db.users.insertOne({ name: "Alice", age: 30 })
> db.users.find({ age: { $gte: 25 } })
```

## Authentication

In dev mode, PlugPort operates without authentication. For production, PlugPort supports three auth methods:

1. **Session Cookie (SIWE)** — Recommended. Sign-In with Ethereum via the Dashboard.
2. **Wallet-Linked API Key** — Generated from the Dashboard. Use as `Authorization: Bearer pp_live_...`.
3. **Legacy Static Key** — Set `API_KEY` env var. Use via `x-api-key` header.

See the [HTTP API Reference](/docs/api-reference/http-api#authentication) for full details, including CSRF protection and rate limits.

## What's Next?

- **[Migration Guide](./migration-guide)** - Moving from MongoDB to PlugPort
- **[Architecture](./architecture)** - How PlugPort works under the hood
- **[MonadDb Integration](./monaddb-integration)** - Understanding the blockchain storage layer
- **[SDK Reference](./category/sdk-reference)** - Detailed SDK documentation
