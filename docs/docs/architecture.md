---
id: architecture
title: Architecture
sidebar_position: 3
---

# Architecture

PlugPort bridges traditional database models (MongoDB, PostgreSQL, MySQL, Redis, SQLite) with MonadDb's Merkle Patricia Trie storage. This page explains how every layer works.

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
                    │   │RoutingAdapter│  │
                    │   └──────┬──────┘   │
                    └──────────┼──────────┘
                               │
            ┌──────────────────┴──────────────────┐
            │                                     │
      ┌─────┴─────┐                         ┌─────┴─────┐
      │Public Base│                         │Private Base│
      │(In-Memory)│                         │(Encryption)│
      └───────────┘                         └───────────┘
            │                                     │
            └─────────────────────────────────────┘
                               │
                          MonadDb RPC
                       (Smart Contracts)
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

### 6. Privacy & Security (`privacy-manager.ts` & `encryption-layer.ts`)

Granular access control and encryption at the collection level:
- **Public/Private Modes:** Collections default to public. Setting a collection to private creates a unique AES-256-GCM key.
- **On-Chain Gas Station:** Private collections deploy a `PlugPortPrivateStore` smart contract via the dashboard Wizard, funded by the owner to sponsor user transactions on MonadDb.
- **Whitelists:** Owners can whitelist wallet addresses to grant read/write access to private collections.

### 7. HTTP Server (`http-server.ts`)

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

#### Authentication (Triple-Auth Middleware)

Three auth methods evaluated in priority order:

1. **Session Cookie (SIWE):** Encrypted `iron-session` cookie set after Sign-In with Ethereum (EIP-4361) verification. Stateless, multi-replica safe.
2. **Wallet-Linked API Key:** Keys prefixed `pp_live_` or `pp_test_`, validated against hashed records in KV store. Tied to a wallet address.
3. **Legacy Static Key:** Environment variable `API_KEY`, compared via `timingSafeEqual`.

#### Rate Limiting

Global rate limit of 100 requests / 10 seconds per IP, with stricter per-route limits on auth endpoints:

| Endpoint | Rate Limit |
|----------|-----------|
| `POST /auth/nonce` | 10/min |
| `POST /auth/verify` | 5/min |
| `GET /auth/me` | 30/min |
| `POST /auth/logout` | 10/min |
| All other endpoints | 100/10s (global) |

#### CSRF Protection (Double-Submit Cookie)

Session-authenticated (SIWE) users are protected against Cross-Site Request Forgery:

1. On `/auth/verify` success, a random CSRF token is stored in the encrypted session and set as a non-httpOnly `plugport_csrf` cookie.
2. On every POST/PUT/DELETE request, the middleware validates the `x-csrf-token` header matches the session token.
3. API key auth and legacy key auth are exempt (no cookie-based session to exploit).

Features: CORS, Triple-Auth Middleware, per-route rate limiting, CSRF protection, request timing, API key analytics recording, and error normalization to MongoDB error codes.

### 8. Wire Protocol Server (`wire-server.ts`)

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

### 9. Multi-Protocol Architecture (`protocol-manager.ts`)

PlugPort exposes the same underlying DocumentStore through multiple database protocol frontends:

| Protocol | Port | Translation Layer |
|----------|------|-------------------|
| **MongoDB** | 27017 | Native wire protocol (OP_MSG) |
| **PostgreSQL** | 5432 | SQL → Document ops via `sql-translator.ts` |
| **MySQL** | 3306 | SQL → Document ops via `sql-translator.ts` |
| **Redis** | 6379 | RESP commands → KV ops, includes Pub/Sub |

The `ProtocolManager` handles lifecycle (enable/disable) for each frontend. The SQL Translation Layer (`sql-translator.ts`) parses SQL statements (SELECT, INSERT, UPDATE, DELETE, CREATE INDEX) and converts them to DocumentStore method calls. The `JoinEngine` supports hash, left, right, and cross joins across collections.

Redis support includes GET/SET/DEL/KEYS for KV operations, plus PUBLISH/SUBSCRIBE for real-time messaging via SSE streams.

### 10. API Key System (`api-key-manager.ts` & `analytics-recorder.ts`)

Wallet-linked API keys provide programmatic access tied to a specific Ethereum address:

- **Key generation**: Creates `pp_live_*` or `pp_test_*` prefixed keys with configurable permissions (`read`, `write`, `admin`, `all`) and per-key rate limits.
- **Key rotation**: Generates a new key value while preserving metadata and ownership.
- **Analytics recording**: Every API request made with a key is recorded — endpoint, timestamp, response time. Queryable via `/keys/:hash/analytics` and `/analytics/overview`.
- **Permissions enforcement**: Keys can be scoped to read-only, write-only, or full access. Checked in the auth middleware before each request.

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
