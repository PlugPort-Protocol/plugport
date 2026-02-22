---
id: wire-protocol
title: Wire Protocol Reference
sidebar_label: Wire Protocol
sidebar_position: 2
---

# Wire Protocol Reference

PlugPort implements a subset of the MongoDB wire protocol (OP_MSG) on port 27017. This allows existing MongoDB drivers and tools like `mongosh` to connect directly.

## Connecting

```bash
# mongosh
mongosh mongodb://localhost:27017

# Node.js driver
const client = new MongoClient('mongodb://localhost:27017')

# Python (pymongo)
client = MongoClient('mongodb://localhost:27017')

# Go (mongo-go-driver)
client, _ := mongo.Connect(ctx, options.Client().ApplyURI("mongodb://localhost:27017"))
```

## Protocol Details

### Message Format

PlugPort uses `OP_MSG` (opcode 2013), the modern MongoDB wire protocol message:

```
+----+----+----------+--------+
|  Header (16 bytes)           |
|  - messageLength (int32)     |
|  - requestID    (int32)      |
|  - responseTo   (int32)      |
|  - opCode       (int32=2013) |
+------------------------------+
|  flagBits (uint32)           |
+------------------------------+
|  Section(s)                  |
|  - Kind 0: Body (BSON doc)   |
|  - Kind 1: Sequence (opt.)   |
+------------------------------+
|  Checksum (optional)         |
+------------------------------+
```

### Handshake

When a client connects, it sends a `hello` or `isMaster` command. PlugPort responds with version info and capabilities:

```json
{
  "ismaster": true,
  "maxWireVersion": 17,
  "minWireVersion": 0,
  "maxBsonObjectSize": 16777216,
  "maxMessageSizeBytes": 50331648,
  "maxWriteBatchSize": 100000,
  "ok": 1
}
```

## Supported Commands

### Database Commands

| Command | Status | Notes |
|---------|--------|-------|
| `hello` | ✅ Full | Modern handshake |
| `isMaster` | ✅ Full | Legacy handshake |
| `ping` | ✅ Full | Health check |
| `buildInfo` | ✅ Full | Version info |
| `listCollections` | ✅ Full | |
| `listDatabases` | ⚠️ Partial | Single-db mode |

### CRUD Commands

| Command | Status | Notes |
|---------|--------|-------|
| `insert` | ✅ Full | Batch support |
| `find` | ✅ Full | Filter, sort, projection, limit, skip |
| `update` | ✅ Full | `$set` operator, upsert |
| `delete` | ✅ Full | Single and multi |

### Aggregation

| Command | Status | Notes |
|---------|--------|-------|
| `aggregate` | ⚠️ Basic | Simple pipelines |
| `count` | ✅ Full | |
| `distinct` | ✅ Full | |

### Index Operations

| Command | Status | Notes |
|---------|--------|-------|
| `createIndexes` | ✅ Full | Single-field indexes |
| `dropIndexes` | ✅ Full | |
| `listIndexes` | ✅ Full | |

### Authentication

| Command | Status | Notes |
|---------|--------|-------|
| `saslStart` | ⚠️ Placeholder | Returns success |
| `saslContinue` | ⚠️ Placeholder | Returns success |

:::info
SCRAM authentication is a placeholder that accepts any credentials. For production, use the HTTP API with API key authentication, or deploy behind a network boundary.
:::

### Unsupported Commands

| Command | Status | Alternative |
|---------|--------|-------------|
| `$lookup` | ❌ | Multiple queries |
| `$unwind` | ❌ | Client-side |
| `$group` | ❌ | Client-side |
| `transactions` | ❌ | Single-operation atomicity |
| `changeStreams` | ❌ | Poll-based |
| `$text` search | ❌ | Client-side filter |
| `getMore` | ❌ | Use `limit` + `skip` |

## Usage Examples

### mongosh

```javascript
// Connect
mongosh mongodb://localhost:27017

// Use a database
use myapp

// CRUD
db.users.insertOne({ name: "Alice", age: 30 })
db.users.insertMany([{ name: "Bob" }, { name: "Charlie" }])
db.users.find({ age: { $gte: 25 } }).sort({ age: -1 }).limit(5)
db.users.updateOne({ name: "Alice" }, { $set: { age: 31 } })
db.users.deleteOne({ name: "Charlie" })

// Indexes
db.users.createIndex({ email: 1 }, { unique: true })
db.users.getIndexes()

// Admin
db.adminCommand({ ping: 1 })
show collections
db.users.countDocuments()
db.users.distinct("name")
```
