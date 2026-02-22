---
id: monaddb-integration
title: MonadDb Integration
sidebar_position: 4
slug: /monaddb-integration
---

# MonadDb Integration

PlugPort uses MonadDb's Merkle Patricia Trie as its storage backend. This page explains how the integration works, what it means for developers, and how gas fees are managed.

## How PlugPort Uses MonadDb

MonadDb provides a key-value storage layer where:
- **Keys** are arbitrary byte strings
- **Values** are arbitrary byte strings
- The entire state is stored in a **Merkle Patricia Trie**
- Every state mutation produces a new **root hash** (cryptographic commitment)

PlugPort maps document operations to this KV layer:

```
Document Operation          KV Operation on MonadDb
─────────────────          ────────────────────────
insertOne(doc)         →   put("doc:users:abc", serialized_doc)
                           put("idx:users:_id:abc:abc", "")
find({age: 30})        →   scan("idx:users:age:...", range)
                           get("doc:users:id1"), get("doc:users:id2")
updateOne(filter, $set)→   get + put("doc:users:abc", updated_doc)
                           delete old index entry + put new
deleteOne(filter)      →   delete("doc:users:abc")
                           delete("idx:users:*:abc")
```

## Development vs Production Mode

### Development Mode (Default)

When `MONADDB_ENDPOINT` is not set, PlugPort uses `InMemoryKVStore`:

- All data lives in process memory
- No blockchain interaction
- No gas fees
- Data is lost on restart
- Identical API behavior as production

```bash
# Dev mode - no config needed
pnpm --filter @plugport/server dev
```

### Production Mode

Production mode requires two environment variables: `MONADDB_ENDPOINT` and `MONADDB_PRIVATE_KEY`. The server auto-detects these at startup.

#### Step 1: Generate a Server Keypair

The server needs a wallet to sign write transactions. Generate one:

```bash
# Generate private key and derived address
node -e "
  const crypto = require('crypto');
  const pk = crypto.randomBytes(32).toString('hex');
  const addr = '0x' + crypto.createHash('sha256')
    .update(Buffer.from(pk, 'hex')).digest('hex').slice(24);
  console.log('MONADDB_PRIVATE_KEY=' + pk);
  console.log('Server Address: ' + addr);
"
```

This outputs:
- **Private Key** (64 hex chars) - Goes into `MONADDB_PRIVATE_KEY`. Keep this secret.
- **Server Address** - This is the wallet you fund with MON.

:::warning
Never commit your private key to version control. Use `.env` files (already in `.gitignore`) or secrets management.
:::

#### Step 2: Fund the Server Wallet

**Testnet:**
```bash
curl https://faucet.monad.xyz/api/claim \
  -H "Content-Type: application/json" \
  -d '{"address": "0xYOUR_SERVER_ADDRESS"}'
```

**Mainnet:** Purchase and transfer MON to the server address.

#### Step 3: Configure Environment

Copy the `.env.example` and fill in your values:

```bash
cp .env.example .env
```

```bash
# .env
MONADDB_ENDPOINT=https://monaddb-rpc.monad.xyz/v1
MONADDB_PRIVATE_KEY=your_64_char_hex_private_key
```

#### Step 4: Start in Production Mode

```bash
pnpm --filter @plugport/server start
```

The server logs confirm the mode:
```
[Storage] Mode: MonadDb (Production)
[Storage] Endpoint: https://monaddb-rpc.monad.xyz/v1
[Storage] Wallet: 0x7f3a...
[Storage] Writes cost MON gas. Reads are free.
```

If `MONADDB_PRIVATE_KEY` is missing, the server warns and falls back to in-memory mode.

## Gas Fees and MON Token

### Which Operations Cost Gas?

| Operation | On-Chain Transaction? | Gas Cost |
|-----------|----------------------|----------|
| `get` (reads) | No - RPC `eth_call` | **Free** |
| `scan` (range reads) | No - RPC state query | **Free** |
| `put` (writes) | Yes - state mutation tx | **MON gas** |
| `delete` (deletes) | Yes - state mutation tx | **MON gas** |

### Practical Implications

- **Reading is free**: `find`, `findOne`, `count`, `distinct`, `listCollections`, `health`
- **Writing costs gas**: `insertOne`, `insertMany`, `updateOne`, `deleteOne`, `deleteMany`
- **Index operations cost gas**: `createIndex` (writes index entries), `dropIndex` (deletes entries)

### Gas Estimation

Each document write involves:
- 1 `put` for the document data
- 1 `put` per index on the collection (minimum 1 for `_id`)

An `insertOne` on a collection with 3 indexes = 4 KV `put` transactions.

### Write Batching (Gas Optimization)

The `MonadDbAdapter` supports batching multiple writes into a single transaction to save gas:

```typescript
// Internal optimization used by insertMany, updateOne, etc.
adapter.startBatch();
await adapter.put('doc:users:1', data1);
await adapter.put('idx:users:_id:1', ref1);
await adapter.put('doc:users:2', data2);
await adapter.put('idx:users:_id:2', ref2);
await adapter.flushBatch(); // 1 tx instead of 4
```

This is handled automatically for `insertMany` operations.

:::tip
For testnet development, the faucet provides sufficient MON for thousands of document operations. You do not need large amounts to develop and test.
:::

## Verifiable Storage

### What Makes It Special

Every write to MonadDb produces a cryptographic proof:

```
State:
  Root Hash: 0xabc123...
    ├── doc:users:001 → {name: "Alice", age: 30}
    ├── doc:users:002 → {name: "Bob", age: 25}
    └── idx:users:age:... → pointer to doc

After insert:
  Root Hash: 0xdef456...  (new root)
    ├── doc:users:001 → {name: "Alice", age: 30}
    ├── doc:users:002 → {name: "Bob", age: 25}
    ├── doc:users:003 → {name: "Charlie", age: 35}  ← new
    └── idx:users:age:... → updated
```

Clients can verify:
1. A document exists at a specific path in the trie
2. The value has not been tampered with
3. The state transition was valid (old root → new root)

### State Proofs (Future)

:::info
State proof verification at the SDK level is on the roadmap. Currently, the server verifies proofs internally. Future SDK versions will expose `verifyProof()` methods.
:::

## MonadDb RPC Adapter

The production adapter is implemented in `packages/server/src/storage/monaddb-adapter.ts`. It implements the same `KVAdapter` interface as the in-memory store:

```typescript
import type { KVAdapter } from '@plugport/shared';

export class MonadDbAdapter implements KVAdapter {
    // Reads: free JSON-RPC calls
    async get(key: string): Promise<Buffer | null>   // monaddb_get
    async scan(options: ScanOptions): Promise<KVEntry[]>  // monaddb_scan
    async count(prefix?: string): Promise<number>    // monaddb_count
    async has(key: string): Promise<boolean>          // monaddb_has

    // Writes: signed transactions (cost MON gas)
    async put(key: string, value: Buffer): Promise<void>  // monaddb_put
    async delete(key: string): Promise<boolean>            // monaddb_delete

    // Batch optimization (reduces gas)
    startBatch(): void
    async flushBatch(): Promise<void>
}
```

The server entry point auto-selects the adapter:

```typescript
// packages/server/src/index.ts
function createStorageAdapter(config) {
    if (config.monadDbEndpoint && process.env.MONADDB_PRIVATE_KEY) {
        return createMonadDbAdapter(endpoint, privateKey); // Production
    }
    return new InMemoryKVStore(); // Development
}
```

No code changes needed in DocumentStore, QueryPlanner, or IndexManager - they all work through the `KVAdapter` interface.

## Why MonadDb?

| Property | Benefit for PlugPort |
|----------|-------------------|
| **Merkle Patricia Trie** | Cryptographic proof for every document |
| **Sorted key space** | Efficient range scans for index queries |
| **10,000 TPS** | High-throughput document operations |
| **1-second finality** | Fast write confirmation |
| **EVM-compatible** | Familiar tooling for blockchain developers |
