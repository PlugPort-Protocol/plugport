---
id: http-api
title: HTTP API Reference
sidebar_label: HTTP API
sidebar_position: 1
---

# HTTP API Reference

PlugPort exposes a RESTful HTTP API on port 8080 (configurable via `HTTP_PORT`).

## Authentication

PlugPort supports three authentication methods, evaluated in priority order:

### 1. Session Cookie (SIWE — Recommended)

Sign-In with Ethereum (EIP-4361) provides wallet-based authentication via encrypted cookies.

**Flow:**

```
1. POST /api/v1/auth/nonce   → { nonce: "abc123" }     (stores nonce in session)
2. Sign the SIWE message with your wallet (client-side)
3. POST /api/v1/auth/verify  → { address: "0x...", ok: 1 }  (sets session cookie + CSRF cookie)
4. All subsequent requests automatically include the session cookie
```

The session is encrypted using `iron-session` (AES-256) and stored as an httpOnly cookie. Sessions expire after 24 hours.

### 2. Wallet-Linked API Key

Generate API keys from the dashboard. Keys are prefixed `pp_live_` (production) or `pp_test_` (testing):

```bash
curl -H "Authorization: Bearer pp_live_your-key-here" http://localhost:8080/api/v1/collections
```

### 3. Legacy Static Key

Set the `API_KEY` environment variable and pass it via header:

```bash
API_KEY=your-secret-key pnpm --filter @plugport/server dev
curl -H "x-api-key: your-secret-key" http://localhost:8080/api/v1/collections
```

### CSRF Protection

Session-authenticated (SIWE) mutations require a CSRF token. After `/auth/verify`, the server sets a `plugport_csrf` cookie (readable by JS). Include it on all POST/PUT/DELETE requests:

```bash
curl -X POST \
  -H "Cookie: plugport_session=..." \
  -H "x-csrf-token: <value-from-plugport_csrf-cookie>" \
  http://localhost:8080/api/v1/collections/users/insertOne \
  -d '{"document": {"name": "Alice"}}'
```

API key and legacy key auth do **not** require CSRF tokens.

### Rate Limits

Auth endpoints have stricter per-route rate limits:

| Endpoint | Rate Limit |
|----------|-----------|
| `POST /api/v1/auth/nonce` | 10/min per IP |
| `POST /api/v1/auth/verify` | 5/min per IP |
| `GET /api/v1/auth/me` | 30/min per IP |
| `POST /api/v1/auth/logout` | 10/min per IP |
| All other endpoints | 100 / 10s per IP |

---

## Auth Endpoints

### `POST /api/v1/auth/nonce`

Request a nonce for SIWE message signing.

**Request:**
```json
{ "address": "0x1234..." }
```

**Response:**
```json
{ "nonce": "abc123def456", "ok": 1 }
```

### `POST /api/v1/auth/verify`

Verify a signed SIWE message and establish a session.

**Request:**
```json
{
  "message": "plugport.wtf wants you to sign in...",
  "signature": "0xabc..."
}
```

**Response:**
```json
{ "address": "0x1234...", "ok": 1 }
```

Sets `plugport_session` (httpOnly) and `plugport_csrf` (JS-readable) cookies.

### `GET /api/v1/auth/me`

Check current session status.

**Response (authenticated):**
```json
{ "address": "0x1234...", "chainId": 10143, "ok": 1 }
```

**Response (not authenticated):** `401`

### `POST /api/v1/auth/logout`

Destroy the current session and clear cookies.

**Response:**
```json
{ "ok": 1 }
```

## System Endpoints

### `GET /health`

Returns server health status.

**Response:**
```json
{
  "status": "ok",
  "uptime": 12345,
  "version": "1.0.0",
  "storage": {
    "type": "InMemory",
    "connected": true,
    "keyCount": 1234
  },
  "server": {
    "httpPort": 8080,
    "wirePort": 27017
  }
}
```

### `GET /metrics`

Prometheus-format metrics for scraping.

```
plugport_requests_total{command="find"} 42
plugport_request_duration_ms{quantile="0.95"} 12.5
plugport_errors_total{code="11000"} 3
```

### `GET /api/v1/metrics`

JSON metrics snapshot for dashboard integration.

**Response:**
```json
{
  "requests": {
    "total": 1234,
    "byCommand": { "find": 500, "insert": 300, "update": 200 },
    "byProtocol": { "http": 1000, "wire": 234 }
  },
  "latency": { "p50": 2.1, "p95": 12.5, "p99": 45.0, "avg": 5.3 },
  "errors": { "total": 12, "byCode": { "11000": 5 } },
  "storage": { "keyCount": 5678, "estimatedSizeBytes": 123456 },
  "uptime": 3600,
  "timestamp": 1708300000000
}
```

---

## Collection Management

### `GET /api/v1/collections`

List all collections with stats.

**Response:**
```json
{
  "collections": [
    { "name": "users", "documentCount": 100, "indexCount": 3, "createdAt": 1708300000, "ownerAddress": "0x123...", "mode": "public" }
  ],
  "ok": 1
}
```

### `POST /api/v1/collections/:name/drop`

Drop a collection and all its data.

**Response:**
```json
{ "acknowledged": true, "dropped": true }
```

### `GET /api/v1/collections/:name/stats`

Get collection statistics.

**Response:**
```json
{
  "documentCount": 100,
  "indexCount": 3,
  "storageSizeBytes": 45678,
  "indexes": [
    { "name": "_id_", "field": "_id", "unique": true }
  ]
}
```

### `GET /api/v1/collections/:name/privacy`

Get privacy settings for a collection. Owners see the full object; non-owners see only `mode` and `ownerAddress`.

**Response (owner):**
```json
{
  "ok": 1,
  "privacy": {
    "mode": "private",
    "ownerAddress": "0x123...",
    "accessRoles": { "0xabc...": 1 },
    "contractAddress": "0xdef..."
  }
}
```

**Response (non-owner):**
```json
{
  "ok": 1,
  "privacy": {
    "mode": "private",
    "ownerAddress": "0x123..."
  }
}
```

### `POST /api/v1/collections/:name/privacy`

Set privacy mode for a collection. Requires authentication. Only the collection owner (or first-time setter) can change the mode.

**Request:**
```json
{ "mode": "private" }
```

**Response:**
```json
{ "ok": 1, "collection": "users", "mode": "private" }
```

### `GET /api/v1/collections/:name/roles`

View access roles for a collection. Requires authentication. **Owner only** — returns `403` for non-owners.

**Response:**
```json
{ "accessRoles": { "0xabc...": 1, "0xdef...": 2 }, "ok": 1 }
```

Role values: `1` = read, `2` = write.

### `POST /api/v1/collections/:name/roles`

Grant or revoke access roles. Requires authentication. **Owner only.**

**Request (grant):**
```json
{ "address": "0xabc...", "action": "grant", "role": 1 }
```

**Request (revoke):**
```json
{ "address": "0xabc...", "action": "revoke" }
```

**Response:**
```json
{ "accessRoles": { "0xabc...": 1 }, "ok": 1 }
```

### `GET /api/v1/whitelist`

Get the global address whitelist (public, no auth required).

**Response:**
```json
{ "addresses": ["0xabc...", "0xdef..."], "ok": 1 }
```

### `POST /api/v1/whitelist`

Add or remove an address from the global whitelist. Requires authentication.

**Request:**
```json
{ "address": "0xabc...", "action": "add" }
```

**Response:**
```json
{ "ok": 1, "addresses": ["0xabc..."] }
```

---

## Document Operations

### `POST /api/v1/collections/:name/insertOne`

Insert a single document.

**Request:**
```json
{
  "document": {
    "name": "Alice",
    "email": "alice@example.com",
    "age": 30
  }
}
```

**Response:**
```json
{
  "acknowledged": true,
  "insertedId": "67b2a1f0a1b2c3d4e5f6a7b8",
  "insertedCount": 1
}
```

### `POST /api/v1/collections/:name/insertMany`

Insert multiple documents.

**Request:**
```json
{
  "documents": [
    { "name": "Alice", "age": 30 },
    { "name": "Bob", "age": 25 }
  ]
}
```

**Response:**
```json
{
  "acknowledged": true,
  "insertedCount": 2,
  "insertedIds": ["67b2a1f0...", "67b2a1f1..."]
}
```

### `POST /api/v1/collections/:name/find`

Query documents with filters, sorting, projection, and pagination.

**Request:**
```json
{
  "filter": { "age": { "$gte": 25 } },
  "projection": { "name": 1, "age": 1 },
  "sort": { "age": -1 },
  "limit": 10,
  "skip": 0
}
```

**Response:**
```json
{
  "cursor": {
    "firstBatch": [
      { "_id": "67b2a1f0...", "name": "Alice", "age": 30 },
      { "_id": "67b2a1f1...", "name": "Bob", "age": 25 }
    ],
    "id": 0
  },
  "ok": 1
}
```

### `POST /api/v1/collections/:name/findOne`

Find a single document.

**Request:**
```json
{
  "filter": { "email": "alice@example.com" }
}
```

**Response:**
```json
{
  "document": { "_id": "67b2a1f0...", "name": "Alice", "email": "alice@example.com" }
}
```

Returns `{ "document": null }` if no match found.

### `POST /api/v1/collections/:name/updateOne`

Update a single document.

**Request:**
```json
{
  "filter": { "_id": "67b2a1f0..." },
  "update": { "$set": { "age": 31, "updatedAt": "2024-01-01T00:00:00Z" } },
  "upsert": false
}
```

**Response:**
```json
{
  "acknowledged": true,
  "matchedCount": 1,
  "modifiedCount": 1,
  "upsertedId": null
}
```

### `POST /api/v1/collections/:name/deleteOne`

Delete a single document.

**Request:**
```json
{ "filter": { "_id": "67b2a1f0..." } }
```

**Response:**
```json
{ "acknowledged": true, "deletedCount": 1 }
```

### `POST /api/v1/collections/:name/deleteMany`

Delete all documents matching the filter.

**Request:**
```json
{ "filter": { "status": "inactive" } }
```

**Response:**
```json
{ "acknowledged": true, "deletedCount": 5 }
```

---

## Index Operations

### `POST /api/v1/collections/:name/createIndex`

Create an index on a field.

**Request:**
```json
{ "field": "email", "unique": true }
```

**Response:**
```json
{ "acknowledged": true, "indexName": "email_1" }
```

### `GET /api/v1/collections/:name/indexes`

List all indexes on the collection.

**Response:**
```json
{
  "indexes": [
    { "name": "_id_", "field": "_id", "unique": true },
    { "name": "email_1", "field": "email", "unique": true }
  ]
}
```

### `POST /api/v1/collections/:name/dropIndex`

Drop an index by name.

**Request:**
```json
{ "name": "email_1" }
```

**Response:**
```json
{ "acknowledged": true }
```

---

## Error Responses

All errors follow MongoDB-compatible error codes:

```json
{
  "ok": 0,
  "code": 11000,
  "codeName": "DuplicateKey",
  "errmsg": "Duplicate key error: field 'email' value 'alice@example.com'"
}
```

| HTTP Status | Error Code | Description |
|-------------|-----------|-------------|
| 400 | 2 | Bad value / invalid request |
| 401 | 13 | Unauthorized (missing API key) |
| 404 | 26 | Namespace/collection not found |
| 409 | 11000 | Duplicate key violation |
| 413 | 10334 | Document too large |
| 500 | 1 | Internal server error |
