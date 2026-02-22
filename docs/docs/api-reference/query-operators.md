---
id: query-operators
title: Query Operators
sidebar_label: Query Operators
sidebar_position: 3
---

# Query Operators

PlugPort supports a subset of MongoDB query operators. All operators work identically across the HTTP API, wire protocol, and SDKs.

## Comparison Operators

### `$eq` - Equals

```json
{ "status": { "$eq": "active" } }
// Shorthand (implicit $eq):
{ "status": "active" }
```

### `$ne` - Not Equals

```json
{ "status": { "$ne": "inactive" } }
```

### `$gt` - Greater Than

```json
{ "age": { "$gt": 25 } }
```

### `$gte` - Greater Than or Equal

```json
{ "age": { "$gte": 18 } }
```

### `$lt` - Less Than

```json
{ "price": { "$lt": 100 } }
```

### `$lte` - Less Than or Equal

```json
{ "score": { "$lte": 50 } }
```

### `$in` - In Array

```json
{ "role": { "$in": ["admin", "moderator", "editor"] } }
```

### Combining Range Operators

```json
{ "age": { "$gte": 18, "$lt": 65 } }
```

## Logical Operators

### `$and` - Logical AND

```json
{
  "$and": [
    { "status": "active" },
    { "age": { "$gte": 18 } }
  ]
}
```

### Implicit AND

Multiple conditions in the same filter document use implicit AND:

```json
{ "status": "active", "age": { "$gte": 18 } }
```

This is equivalent to the explicit `$and` above.

## Index Usage

Operators that can use index scans for better performance:

| Operator | Index Scan? | Notes |
|----------|------------|-------|
| `$eq` | ✅ Yes | Exact key lookup |
| `$gt` | ✅ Yes | Range scan from value |
| `$gte` | ✅ Yes | Range scan from value (inclusive) |
| `$lt` | ✅ Yes | Range scan up to value |
| `$lte` | ✅ Yes | Range scan up to value (inclusive) |
| `$ne` | ❌ No | Full scan with post-filter |
| `$in` | ❌ No | Multiple lookups, falls back to scan |
| `$and` | ⚠️ Partial | Uses best single-field index |

:::tip
Create indexes on fields you query with `$eq`, `$gt`, `$gte`, `$lt`, `$lte` for optimal performance.
:::

## Projection

Control which fields are returned:

### Include Fields

```json
{ "projection": { "name": 1, "email": 1 } }
```

Returns only `_id`, `name`, and `email`.

### Exclude Fields

```json
{ "projection": { "password": 0, "internalNotes": 0 } }
```

Returns all fields except `password` and `internalNotes`.

:::warning
Do not mix include (1) and exclude (0) in the same projection (except `_id`). This matches MongoDB's behavior.
:::

## Sort

```json
{ "sort": { "age": 1 } }      // Ascending
{ "sort": { "age": -1 } }     // Descending
{ "sort": { "age": -1, "name": 1 } }  // Multi-field sort
```

## Pagination

```json
{
  "filter": {},
  "sort": { "createdAt": -1 },
  "skip": 20,
  "limit": 10
}
```

## Update Operators

### `$set` - Set Fields

```json
{
  "update": {
    "$set": {
      "name": "Updated Name",
      "metadata.lastModified": "2024-01-01T00:00:00Z"
    }
  }
}
```

## Roadmap Operators

These operators are planned for future releases:

| Operator | Type | Status |
|----------|------|--------|
| `$or` | Logical | Planned |
| `$not` | Logical | Planned |
| `$regex` | Evaluation | Planned |
| `$exists` | Element | Planned |
| `$type` | Element | Planned |
| `$inc` | Update | Planned |
| `$unset` | Update | Planned |
| `$push` | Array Update | Planned |
| `$pull` | Array Update | Planned |
