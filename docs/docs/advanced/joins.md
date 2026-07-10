---
id: joins
title: SQL JOINs Performance Guide
sidebar_label: SQL JOINs
sidebar_position: 1
---

# SQL JOINs in PlugPort — Performance Guide

## Overview

PlugPort supports SQL JOINs across all SQL-compatible protocols (PostgreSQL, MySQL). JOINs are executed as **application-level operations** — both collections are read from Monad, correlated in-memory, and the merged result is returned to the client.

## JOIN Strategies

### 1. Hash Join (INNER JOIN)

**Complexity:** O(N + M) time, O(min(N,M)) memory

The default strategy for `INNER JOIN`. Builds a hash table on the smaller collection, probes with the larger.

```sql
SELECT u.name, o.total
FROM users u
INNER JOIN orders o ON u.id = o.user_id;
```

**Execution:**
1. Fetch `users` collection from Monad (1 RPC call)
2. Fetch `orders` collection from Monad (1 RPC call)
3. Build hash map: `{ user.id → [user_doc, ...] }`
4. For each order, probe hash map with `order.user_id`
5. Emit merged row for each match

### 2. Left/Right Join

**Complexity:** O(N + M) time (hash-based)

All rows from the primary side, matching rows from the secondary (NULL if no match).

```sql
SELECT u.name, COALESCE(o.total, 0) as total
FROM users u
LEFT JOIN orders o ON u.id = o.user_id;
```

### 3. Index-Assisted Join

**Complexity:** O(N + batch_call)

When the left side has fewer than 5,000 rows, PlugPort extracts join keys and uses `$in` filter on the right side. This pushes filtering to the KV layer, reducing data transfer.

```
Left: 100 users → extract user_ids [1, 2, ..., 100]
Right: orders WHERE user_id IN [1, 2, ..., 100]  ← filtered scan
```

### 4. Cross Join (CROSS JOIN)

**Complexity:** O(N × M)

Cartesian product, **capped at 10,000 rows** to prevent OOM.

```sql
SELECT * FROM sizes CROSS JOIN colors;
-- Sizes: 5 rows × Colors: 10 rows = 50 rows ✓
-- Users: 10K × Orders: 10K = 100M rows ✗ (blocked)
```

## Performance Characteristics

### RPC Round-Trip Optimization

| Scenario | Without PlugPortRelational | With PlugPortRelational |
|----------|---------------------------|------------------------|
| 2-table JOIN (1K × 1K) | 2 RPC calls | 2 RPC calls |
| 3-table JOIN (1K × 1K × 1K) | 3 RPC calls | 3 RPC calls |
| JOIN with filter push-down | N+1 calls (N = left rows) | 3 calls (batch read) |
| Nested subquery | 2 × N calls | 3 calls |

### Memory Usage

| Join Size | Memory Estimate | Time Estimate |
|-----------|-----------------|---------------|
| 100 × 100 | ~1 MB | &lt;50ms |
| 1K × 1K | ~10 MB | &lt;200ms |
| 10K × 10K | ~100 MB | &lt;2s |
| 100K × 100K | ~1 GB | ~20s |

> **Recommendation:** For joins with more than 10K rows per side, add WHERE clauses to reduce the working set.

## Multi-Table JOINs

PlugPort supports chained JOINs (A JOIN B JOIN C):

```sql
SELECT u.name, o.total, p.product_name
FROM users u
INNER JOIN orders o ON u.id = o.user_id
INNER JOIN products p ON o.product_id = p.id
WHERE u.country = 'US'
ORDER BY o.total DESC
LIMIT 50;
```

**Execution order:**
1. Fetch `users` with filter `country = 'US'`
2. Fetch `orders` with `$in` optimization
3. Hash join `users × orders`
4. Fetch `products` with `$in` optimization
5. Hash join `(users×orders) × products`
6. Sort by `o.total DESC`
7. Limit to 50 rows

## Aggregation with JOINs

```sql
SELECT u.country, COUNT(*) as order_count, SUM(o.total) as revenue
FROM users u
INNER JOIN orders o ON u.id = o.user_id
GROUP BY u.country
HAVING SUM(o.total) > 1000
ORDER BY revenue DESC;
```

Aggregation is computed in-memory after the JOIN completes.

## PlugPortRelational.sol — Batch Read Optimization

Deploy `PlugPortRelational.sol` to enable batch reads that further optimize JOINs:

```solidity
// Single RPC call to fetch 1000 keys
function batchGet(bytes32[] keys) external view returns (bytes[] values, bool[] exists)
```

### Benefits

- **Reduces RPC calls** for right-side index-assisted lookups from N to 1
- **All view functions** — no gas cost
- **Wraps existing PlugPortStore** — no data migration needed

### Deployment

```bash
# Deploy PlugPortRelational with your PlugPortStore address
RELATIONAL_CONTRACT_ADDRESS=0x...deployed_address...
```

## Best Practices

1. **Add WHERE clauses** to filter early and reduce in-memory data
2. **Index join columns** with `CREATE INDEX` for faster lookups
3. **Prefer INNER JOIN** over CROSS JOIN
4. **Use LIMIT** to cap result sizes
5. **Deploy PlugPortRelational** for production JOINs
6. **Monitor memory** — joins on large collections use proportional memory
