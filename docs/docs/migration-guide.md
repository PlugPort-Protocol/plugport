---
id: migration-guide
title: Migration Guide
sidebar_position: 2
slug: /migration-guide
---

# Migration Guide: MongoDB to PlugPort

PlugPort is designed as a drop-in replacement for MongoDB. This guide covers every migration path, from zero-code changes (wire protocol) to SDK-level migrations.

## Migration Strategies

| Strategy | Code Changes | Best For |
|----------|-------------|----------|
| **Wire Protocol** | Zero | Apps using `mongosh`, `pymongo`, `mongo-go-driver` |
| **SDK Swap** | 2 lines | Apps willing to use PlugPort SDK for extra features |
| **Gradual** | Incremental | Large codebases migrating collection by collection |

---

## Strategy 1: Wire Protocol (Zero Code Changes)

The simplest path. PlugPort speaks the MongoDB wire protocol on port 27017. Simply point your existing MongoDB URI to the PlugPort server.

### Before

```bash
# Environment variable
MONGODB_URI=mongodb://mongo-server:27017/myapp
```

### After

```bash
# Just change the host
MONGODB_URI=mongodb://plugport-server:27017/myapp
```

**That's it.** Your existing `pymongo`, `mongo-go-driver`, or `mongosh` code connects directly - no library changes needed.

### Supported Wire Protocol Commands

| Command | Status | Notes |
|---------|--------|-------|
| `hello` / `isMaster` | ✅ Supported | Full handshake |
| `ping` | ✅ Supported | |
| `insert` | ✅ Supported | Single and batch |
| `find` | ✅ Supported | Filter, sort, projection, limit, skip |
| `update` | ✅ Supported | `$set` operator |
| `delete` | ✅ Supported | Single and multi |
| `createIndexes` | ✅ Supported | Single-field indexes |
| `listCollections` | ✅ Supported | |
| `count` | ✅ Supported | |
| `distinct` | ✅ Supported | |
| `aggregate` | ⚠️ Basic | Simple pipelines only |
| `transactions` | ❌ Not yet | Roadmap item |
| `$lookup` | ❌ Not yet | Roadmap item |

---

## Strategy 2: SDK Swap (2-Line Change)

For applications that want to use the PlugPort SDK directly, the migration is exactly 2 lines of code.

### Node.js

```diff
- import { MongoClient } from 'mongodb';
+ import { PlugPortClient } from '@plugport/sdk';

- const client = await MongoClient.connect('mongodb://localhost:27017');
+ const client = await PlugPortClient.connect('http://localhost:8080');

  // Everything below is IDENTICAL
  const db = client.db('myapp');
  const users = db.collection('users');

  await users.insertOne({ name: 'Alice', email: 'alice@example.com' });
  const docs = await users.find({ age: { $gte: 25 } });
  await users.updateOne({ name: 'Alice' }, { $set: { age: 31 } });
  await users.createIndex('email', { unique: true });
  await client.close();
```

### Python

```diff
- from pymongo import MongoClient
+ from plugport import PlugPortClient

- client = MongoClient("mongodb://localhost:27017")
+ client = PlugPortClient("http://localhost:8080")

  # Everything below is IDENTICAL
  db = client["myapp"]
  users = db["users"]

  users.insert_one({"name": "Alice", "email": "alice@example.com"})
  docs = users.find({"age": {"$gte": 25}})
  users.update_one({"name": "Alice"}, {"$set": {"age": 31}})
```

### Go

```diff
- import "go.mongodb.org/mongo-driver/mongo"
+ import plugport "github.com/plugport/plugport-go"

- client, _ := mongo.Connect(ctx, options.Client().ApplyURI("mongodb://localhost:27017"))
+ client, _ := plugport.Connect("http://localhost:8080")

  // Everything below is IDENTICAL
  coll := client.Database("myapp").Collection("users")
  coll.InsertOne(ctx, map[string]interface{}{"name": "Alice"})
```

---

## Strategy 3: Gradual Migration

For large codebases, migrate one collection at a time.

### Step 1: Run Both Databases

```bash
# MongoDB continues running on 27017
# PlugPort runs on different ports
HTTP_PORT=8080 WIRE_PORT=27018 pnpm --filter @plugport/server dev
```

### Step 2: Migrate Data with the CLI

```bash
# Export from MongoDB
mongoexport --collection=users --out=users.json

# Import into PlugPort
plugport migrate --file users.json --collection users
```

### Step 3: Switch Connections Per Collection

```typescript
// Use a factory to decide which driver to use per collection
function getCollection(name: string) {
  const migratedCollections = ['users', 'products'];

  if (migratedCollections.includes(name)) {
    return plugportDb.collection(name);  // PlugPort
  }
  return mongoDb.collection(name);      // Legacy MongoDB
}
```

### Step 4: After Full Migration

Remove the MongoDB dependency entirely.

---

## Data Format Compatibility

### What Maps Directly

| MongoDB Feature | PlugPort Support |
|----------------|-----------------|
| JSON documents | ✅ Full |
| `_id` field (ObjectId) | ✅ Full (24-char hex) |
| Nested objects | ✅ Full |
| Arrays | ✅ Full |
| BSON types | ✅ Via wire protocol |
| Dot notation in queries | ⚠️ Top-level fields only (MVP) |
| `$set` operator | ✅ Full |
| `$gt/$lt/$gte/$lte` | ✅ Full |
| `$in/$eq/$ne` | ✅ Full |
| `$and` | ✅ Full |
| `$or` | ❌ Roadmap |
| `$regex` | ❌ Roadmap |
| Sort | ✅ Full |
| Projection (include/exclude) | ✅ Full |
| Skip/Limit | ✅ Full |
| Single-field indexes | ✅ Full |
| Compound indexes | ❌ Roadmap |
| TTL indexes | ❌ Roadmap |
| Unique constraints | ✅ Full |
| Transactions | ❌ Roadmap |

### ObjectId Format

MongoDB uses BSON ObjectId (12 bytes). PlugPort generates 24-character hex strings in the same format:

```
|  timestamp  |    random    |
|  8 chars    |   16 chars   |
|-------------|--------------|
  67b2a1f0     a1b2c3d4e5f6a7b8
```

Both are compatible for querying and sorting by insertion order.

---

## Cost Considerations

### Development (Free)

In dev mode, PlugPort uses an in-memory store. No blockchain interaction, no gas fees.

### Production (MON Tokens)

When connected to MonadDb (production):

| Operation Type | On-Chain? | Cost |
|---------------|-----------|------|
| **Reads** (find, findOne, count) | No (RPC call) | **Free** |
| **Writes** (insert, update, delete) | Yes (transaction) | MON gas fee |
| **Index operations** | Yes (KV writes) | MON gas fee |

:::tip
The PlugPort server handles all blockchain interaction. Your application code never needs to manage wallets or sign transactions. Fund the server's wallet and it handles the rest.
:::

---

## Troubleshooting

### "No such command" errors via wire protocol

Some advanced MongoDB commands are not yet supported. Check the [Wire Protocol Reference](./api-reference/wire-protocol) for the full list.

### Duplicate key errors after migration

If your data has documents with the same `_id`, the import will fail. De-duplicate before importing:

```bash
# Remove duplicate lines from the export
sort -u users.json > users_dedup.json
plugport migrate --file users_dedup.json --collection users
```

### Performance differences

PlugPort's query planner currently optimizes for single-field index scans. Complex multi-field queries fall back to collection scans. Create indexes on your most-queried fields for best performance.
