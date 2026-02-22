---
id: http-api
title: HTTP API Reference
sidebar_label: HTTP API
sidebar_position: 1
---

# HTTP API Reference

PlugPort exposes a RESTful HTTP API on port 8080 (configurable via `HTTP_PORT`).

## Authentication

Set the `API_KEY` environment variable to enable API key authentication:

```bash
API_KEY=your-secret-key pnpm --filter @plugport/server dev
```

Then include the key in requests:

```bash
curl -H "x-api-key: your-secret-key" http://localhost:8080/api/v1/collections
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
    { "name": "users", "documentCount": 100, "indexCount": 3, "createdAt": 1708300000 }
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
