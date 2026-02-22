---
id: architecture
title: Architecture
sidebar_position: 3
slug: /architecture
---

# Architecture

PlugPort bridges MongoDB's document model with MonadDb's Merkle Patricia Trie storage. This page explains how every layer works.

## High-Level Architecture

```
                    ┌─────────────────────┐
                    │     Client Apps      │
                    │ (Node.js/Python/Go)  │
                    └──────┬──────┬───────┘
                           │      │
              MongoDB Wire │      │ HTTP REST
              Protocol     │      │ API
              (port 27017) │      │ (port 8080)
                           │      │
                    ┌──────┴──────┴───────┐
                    │    PlugPort Server    │
                    ├─────────────────────┤
                    │   ┌─────────────┐   │
                    │   │  Document   │   │
                    │   │    Store    │   │
                    │   └──────┬──────┘   │
                    │          │          │
                    │   ┌──────┴──────┐   │
                    │   │Query Planner│   │
                    │   │Index Manager│   │
                    │   └──────┬──────┘   │
                    │          │          │
                    │   ┌──────┴──────┐   │
                    │   │Key Encoding │   │
                    │   └──────┬──────┘   │
                    │          │          │
                    │   ┌──────┴──────┐   │
                    │   │ KV Adapter  │   │
                    │   │ (interface) │   │
                    │   └──────┬──────┘   │
                    └──────────┼──────────┘
                               │
                  ┌────────────┼────────────┐
                  │                         │
           ┌──────┴──────┐          ┌───────┴───────┐
           │InMemoryKV   │          │  MonadDb RPC  │
           │(dev mode)   │          │  (production) │
           └─────────────┘          └───────────────┘
```

## Core Components

### 1. KV Adapter (`kv-adapter.ts`)

The foundation of PlugPort. All data operations flow through this interface:

```typescript
interface KVAdapter {
  get(key: string): Promise<Buffer | null>;
  put(key: string, value: Buffer): Promise<void>;
  delete(key: string): Promise<boolean>;
  scan(options: ScanOptions): Promise<KVEntry[]>;
  has(key: string): Promise<boolean>;
  count(prefix?: string): Promise<number>;
  clear(): Promise<void>;
}
```

The `InMemoryKVStore` implementation maintains a sorted key array for lexicographic scans, mimicking MonadDb's trie traversal. This is the single swap-point for production MonadDb integration.

### 2. Key Encoding (`key-encoding.ts`)

Maps documents, indexes, and metadata to KV keys with sort-preserving encoding.

#### Key Format

```
doc:<collection>:<id>          → Document data (JSON/BSON)
idx:<collection>:<field>:<encoded_value>:<id>  → Index entry
meta:collection:<collection>   → Collection metadata
```

#### Number Encoding (IEEE 754)

The most complex piece. Numbers must sort lexicographically in the same order as their numeric values. PlugPort achieves this with IEEE 754 bit manipulation:

```
Positive numbers: flip the sign bit (0→1)
Negative numbers: flip ALL bits (ones' complement)
```

This ensures: `-100 < -10 < -1 < 0 < 1 < 10 < 100` in string sort order.

```typescript
// Encoding flow
number → Buffer.writeDoubleBE → bit manipulation → hex string
-3.14  → [buffer]             → flip all bits   → "2:7ff3..."
 3.14  → [buffer]             → flip sign bit   → "2:c00..."
```

### 3. Index Manager (`index-manager.ts`)

Manages index lifecycle and maintains consistency with document operations.

#### Index Flow on Insert

```
insertOne({name: "Alice", age: 30})
    │
    ├─ Put doc:users:abc123 → {name: "Alice", age: 30}
    │
    ├─ Put idx:users:_id:abc123:abc123 → ""       (auto _id index)
    │
    └─ If index on "age" exists:
       Put idx:users:age:2:c03e...:abc123 → ""    (encoded value of 30)
```

#### Unique Constraint Enforcement

Before inserting an index entry, PlugPort scans for existing entries with the same encoded value. If found, it throws `E11000 DuplicateKey`.

#### Retroactive Index Building

When you create an index on an existing collection, PlugPort:
1. Scans all documents (`doc:<collection>:*`)
2. Extracts the indexed field value from each
3. Creates index entries for all existing documents

### 4. Query Planner (`query-planner.ts`)

Decides how to execute a query. Two strategies:

| Strategy | When Used | Performance |
|----------|-----------|-------------|
| **Index Scan** | Filter on indexed field | O(log n + k) |
| **Collection Scan** | No matching index | O(n) |

```
Filter: { age: { $gte: 25, $lt: 40 } }
                    │
                    ▼
        ┌─ Has index on "age"? ─┐
        │                       │
      Yes                      No
        │                       │
   Index Scan             Collection Scan
   (range: encoded      (scan all docs,
    25 → encoded 40)     filter in memory)
```

For multi-field filters, the planner picks the best single-field index and post-filters the remaining conditions.

### 5. Document Store (`document-store.ts`)

The orchestrator that ties everything together:

- **Auto-creates collections** on first insert (with `_id` index)
- **Generates ObjectId-like IDs** (8-char timestamp + 16-char random)
- **Validates document size** (default 1MB limit)
- **Coordinates** IndexManager and QueryPlanner for all CRUD operations
- **Manages collection metadata** (index definitions, doc count, schema version)

### 6. HTTP Server (`http-server.ts`)

Fastify-based REST API exposing 17 endpoints:

```
GET  /health                              → Health check
GET  /metrics                             → Prometheus metrics
GET  /api/v1/metrics                      → JSON metrics snapshot
GET  /api/v1/collections                  → List collections
POST /api/v1/collections/:name/insertOne  → Insert one document
POST /api/v1/collections/:name/insertMany → Insert multiple
POST /api/v1/collections/:name/find       → Query documents
POST /api/v1/collections/:name/findOne    → Find one document
POST /api/v1/collections/:name/updateOne  → Update one
POST /api/v1/collections/:name/deleteOne  → Delete one
POST /api/v1/collections/:name/deleteMany → Delete many
POST /api/v1/collections/:name/createIndex → Create index
POST /api/v1/collections/:name/dropIndex  → Drop index
GET  /api/v1/collections/:name/indexes    → List indexes
GET  /api/v1/collections/:name/stats      → Collection stats
POST /api/v1/collections/:name/drop       → Drop collection
```

Features: CORS, API key authentication, request timing, error normalization to MongoDB error codes.

### 7. Wire Protocol Server (`wire-server.ts`)

TCP server on port 27017 implementing MongoDB's `OP_MSG` protocol:

```
Client                    PlugPort
  │                          │
  │─── TCP connect ─────────>│
  │                          │
  │─── OP_MSG (hello) ──────>│
  │<── OP_MSG (handshake) ───│
  │                          │
  │─── OP_MSG (insert) ─────>│
  │<── OP_MSG (result) ──────│
  │                          │
```

Each message has a 16-byte header (length, requestId, opCode) followed by BSON sections. The server parses BSON, routes to DocumentStore, and serializes the response back to BSON.

## Data Flow: Insert Operation

```
SDK: users.insertOne({name: "Alice", age: 30})
  │
  ├─ HTTP Transport: POST /api/v1/collections/users/insertOne
  │   └─ Body: {"document": {"name": "Alice", "age": 30}}
  │
  ├─ HTTP Server: Parse request, validate
  │
  ├─ DocumentStore.insert("users", [{name: "Alice", age: 30}])
  │   ├─ Auto-create collection "users" (if first insert)
  │   ├─ Generate _id: "67b2a1f0a1b2c3d4e5f6a7b8"
  │   ├─ Validate document size < 1MB
  │   ├─ IndexManager.onInsert() → write index entries
  │   │   ├─ Put idx:users:_id:...:67b2a1f0... → ""
  │   │   └─ (any other indexes)
  │   ├─ KVAdapter.put("doc:users:67b2a1f0...", serialized_doc)
  │   └─ Update collection metadata (doc count)
  │
  └─ Response: { acknowledged: true, insertedId: "67b2a1f0..." }
```

## Data Flow: Query with Index

```
SDK: users.find({ age: { $gte: 25 } })
  │
  ├─ QueryPlanner.planQuery({ age: { $gte: 25 } }, indexes)
  │   └─ Result: IndexScan on "age", startKey = encodeNumber(25)
  │
  ├─ KVAdapter.scan({ prefix: "idx:users:age:", startKey: "idx:users:age:2:c039..." })
  │   └─ Returns: [{key: "idx:users:age:2:c039...:id1"}, {key: "idx:users:age:2:c042...:id2"}]
  │
  ├─ For each index entry, extract document ID from key
  │   ├─ KVAdapter.get("doc:users:id1") → document 1
  │   └─ KVAdapter.get("doc:users:id2") → document 2
  │
  ├─ Apply post-filter (if multi-field query)
  ├─ Apply sort, projection, skip, limit
  │
  └─ Response: { cursor: { firstBatch: [...], id: 0 }, ok: 1 }
```
