---
id: nodejs
title: Node.js SDK
sidebar_label: Node.js
sidebar_position: 1
---

# Node.js SDK

The `@plugport/sdk` package provides a MongoDB driver-compatible API for Node.js and TypeScript applications.

## Installation

```bash
npm install @plugport/sdk
# or
pnpm add @plugport/sdk
```

## Quick Start

```typescript
import { PlugPortClient } from '@plugport/sdk';

const client = await PlugPortClient.connect('http://localhost:8080');
const db = client.db('myapp');
const users = db.collection('users');

// Insert
const result = await users.insertOne({
  name: 'Alice',
  email: 'alice@example.com',
  age: 30,
});
console.log('Inserted:', result.insertedId);

await client.close();
```

## API Reference

### `PlugPortClient`

#### `PlugPortClient.connect(uri, options?)`

Creates a new client and verifies the connection.

```typescript
const client = await PlugPortClient.connect('http://localhost:8080', {
  apiKey: 'your-api-key',  // optional
});
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `uri` | `string` | Server URL (`http://` or `plugport://`) |
| `options.apiKey` | `string?` | API key for authentication |

#### `client.db(name)`

Returns a `Database` reference.

```typescript
const db = client.db('myapp');
```

#### `client.health()`

Returns server health status.

```typescript
const health = await client.health();
// { status: 'ok', uptime: 12345, version: '1.0.0', storage: {...} }
```

#### `client.metrics()`

Returns performance metrics snapshot.

#### `client.close()`

Closes the connection.

---

### `Database`

#### `db.collection(name)`

Returns a typed `Collection` reference.

```typescript
interface User {
  name: string;
  email: string;
  age: number;
}

const users = db.collection<User>('users');
```

#### `db.listCollections()`

Lists all collections.

```typescript
const { collections } = await db.listCollections();
// [{ name: 'users', documentCount: 10, indexCount: 2 }]
```

---

### `Collection`

#### `insertOne(document)`

```typescript
const result = await users.insertOne({
  name: 'Alice',
  email: 'alice@example.com',
  age: 30,
});
// { acknowledged: true, insertedId: '67b2a1f0...', insertedCount: 1 }
```

#### `insertMany(documents)`

```typescript
const result = await users.insertMany([
  { name: 'Alice', age: 30 },
  { name: 'Bob', age: 25 },
]);
// { acknowledged: true, insertedCount: 2, insertedIds: ['...', '...'] }
```

#### `find(filter, options?)`

```typescript
// All users
const allUsers = await users.find();

// With filter
const adults = await users.find({ age: { $gte: 18 } });

// With options
const topUsers = await users.find(
  { status: 'active' },
  {
    sort: { score: -1 },
    limit: 10,
    skip: 0,
    projection: { name: 1, score: 1 },
  }
);
```

#### `findOne(filter, options?)`

```typescript
const user = await users.findOne({ email: 'alice@example.com' });
// Returns the document or null
```

#### `updateOne(filter, update, options?)`

```typescript
const result = await users.updateOne(
  { name: 'Alice' },
  { $set: { age: 31, updatedAt: new Date().toISOString() } },
  { upsert: false }
);
// { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null }
```

#### `deleteOne(filter)`

```typescript
const result = await users.deleteOne({ name: 'Alice' });
// { acknowledged: true, deletedCount: 1 }
```

#### `deleteMany(filter)`

```typescript
const result = await users.deleteMany({ status: 'inactive' });
// { acknowledged: true, deletedCount: 5 }
```

#### `createIndex(field, options?)`

```typescript
const result = await users.createIndex('email', { unique: true });
// { acknowledged: true, indexName: 'email_1' }
```

#### `dropIndex(indexName)`

```typescript
await users.dropIndex('email_1');
```

#### `listIndexes()`

```typescript
const { indexes } = await users.listIndexes();
// [{ name: '_id_', field: '_id', unique: true }, ...]
```

#### `stats()`

```typescript
const stats = await users.stats();
// { documentCount: 100, indexCount: 3, storageSizeBytes: 45678 }
```

#### `countDocuments(filter?)`

```typescript
const count = await users.countDocuments({ status: 'active' });
```

#### `drop()`

```typescript
await users.drop();
```

## Error Handling

```typescript
import { PlugPortError } from '@plugport/sdk';

try {
  await users.insertOne({ email: 'alice@example.com' });
} catch (err) {
  if (err instanceof PlugPortError) {
    console.log(err.code);    // 11000 (duplicate key)
    console.log(err.message); // "Duplicate key error..."
  }
}
```

## TypeScript Support

The SDK is fully typed. Use generics for strong typing:

```typescript
interface Product {
  name: string;
  price: number;
  category: string;
  stock: number;
}

const products = db.collection<Product>('products');

// TypeScript knows the shape of documents
await products.insertOne({
  name: 'Widget',
  price: 29.99,
  category: 'electronics',
  stock: 100,
});
```
