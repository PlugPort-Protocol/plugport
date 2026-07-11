---
id: sqlite-compat
title: SQLite Compat
sidebar_label: SQLite Compat
sidebar_position: 5
---

# SQLite Compat SDK

The `@plugport/sqlite-compat` package provides a drop-in replacement for the popular `better-sqlite3` library. It translates synchronous SQLite queries into PlugPort's HTTP REST API, allowing SQLite-based applications to run on verifiable MonadDb storage without rewriting any SQL logic.

## Installation

```bash
npm install @plugport/sqlite-compat
# or
pnpm add @plugport/sqlite-compat
```

## Quick Start

### 1. Replace the Import

Swap `better-sqlite3` for `@plugport/sqlite-compat`:

```diff
- import Database from 'better-sqlite3';
+ import Database from '@plugport/sqlite-compat';
```

### 2. Connect and Query

Pass the PlugPort HTTP endpoint instead of a local file path:

```typescript
import Database from '@plugport/sqlite-compat';

// Connect to PlugPort instead of a local .db file
const db = new Database('http://localhost:8080', {
    apiKey: 'pp_test_1234567890abcdef', // optional
    timeout: 5000,                       // optional, ms
    verbose: true,                       // optional, logs SQL
});

// Standard SQLite operations — same API as better-sqlite3
db.exec('CREATE TABLE users (name TEXT, age INTEGER)');

const insert = db.prepare('INSERT INTO users VALUES (?, ?)');
insert.run('Alice', 30);

const rows = db.prepare('SELECT * FROM users WHERE age >= ?').all(25);
console.log(rows);
```

## Supported API Surface

| Method | Description |
|--------|-------------|
| `db.exec(sql)` | Execute raw SQL (DDL, DML) |
| `db.prepare(sql)` | Create a prepared statement |
| `stmt.run(...params)` | Execute a statement (INSERT, UPDATE, DELETE) |
| `stmt.all(...params)` | Fetch all matching rows |
| `stmt.get(...params)` | Fetch a single row |

## Limitations

- Transactions are acknowledged but not atomic (MonadDb is eventual).
- WAL mode and pragmas are no-ops.
- Virtual tables are not supported.
