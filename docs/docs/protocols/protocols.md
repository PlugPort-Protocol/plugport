---
id: protocols
title: Multi-Protocol Guides
sidebar_label: Protocol Guides
sidebar_position: 1
---

# PlugPort Protocol Guides

## Architecture

PlugPort is a **multi-protocol database middleware** that accepts connections from native database drivers and routes all operations to Monad smart contracts for persistent, decentralized storage.

```
┌─────────────────────────────────────────────────────────┐
│                     Client Layer                        │
│  mongosh  │  psql  │  mysql-cli  │  redis-cli  │  curl │
└─────┬─────┴───┬────┴──────┬──────┴──────┬──────┴───┬───┘
      │         │           │             │          │
      ▼         ▼           ▼             ▼          ▼
┌─────────┬──────────┬───────────┬──────────┬──────────┐
│  :27017 │  :5432   │  :3306    │  :6379   │  :8080   │
│ MongoDB │ Postgres │  MySQL    │  Redis   │  HTTP    │
│  Wire   │  Wire    │  Wire     │  RESP    │  REST    │
└────┬────┴────┬─────┴────┬──────┴────┬─────┴────┬─────┘
     │         │          │           │          │
     └────┬────┴────┬─────┴──────┬────┘          │
          │         │            │               │
          ▼         ▼            ▼               │
   ┌─────────────────────────────────────┐       │
   │    SQL Translator / JOIN Engine     │       │
   │    (PostgreSQL + MySQL only)        │       │
   └─────────────┬───────────────────────┘       │
                 │                               │
                 ▼                               │
   ┌──────────────────────────────────────┐      │
   │          Document Store              │◀─────┘
   │    (collections, filters, indexes)   │
   └─────────────┬────────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────────┐
   │      Encryption Layer (optional)     │
   │      (AES-256-GCM, private mode)     │
   └─────────────┬────────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────────┐
   │          KV Adapter                  │
   │    (MonadAdapter / InMemory)         │
   └─────────────┬────────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────────┐
   │       Monad Blockchain               │
   │   PlugPortStore.sol (public)         │
   │   PlugPortPrivateStore.sol (private) │
   │   PlugPortMessageBroker.sol (pubsub) │
   │   PlugPortRelational.sol (batch)     │
   └──────────────────────────────────────┘
```

---

## PostgreSQL

### Enable

```env
PG_ENABLED=true
PG_PORT=5432
```

### Connect

```bash
psql postgresql://localhost:5432/plugport
```

### Supported SQL

| Category | Statements |
|----------|------------|
| DDL | `CREATE TABLE`, `DROP TABLE`, `CREATE INDEX`, `DROP INDEX` |
| DML | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |
| Queries | `WHERE`, `ORDER BY`, `LIMIT`, `OFFSET`, `DISTINCT` |
| Joins | `INNER JOIN`, `LEFT JOIN`, `RIGHT JOIN`, `CROSS JOIN` |
| Aggregates | `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `GROUP BY`, `HAVING` |
| Operators | `=`, `!=`, `<>`, `>`, `>=`, `<`, `<=`, `IN`, `NOT IN`, `LIKE`, `BETWEEN`, `IS NULL`, `IS NOT NULL` |
| Logical | `AND`, `OR` |
| Admin | `SHOW TABLES`, `DESCRIBE`, `SHOW DATABASES`, `USE` |
| Transactions | `BEGIN`, `COMMIT`, `ROLLBACK` (acknowledged no-ops) |

### Examples

```sql
-- Create a table (collection)
CREATE TABLE users (id INT, name VARCHAR, email VARCHAR);

-- Insert data
INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com');
INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'bob@example.com');

-- Query with filter
SELECT name, email FROM users WHERE id > 1 ORDER BY name;

-- Join example
SELECT u.name, o.total
FROM users u
INNER JOIN orders o ON u.id = o.user_id
WHERE o.total > 100
ORDER BY o.total DESC
LIMIT 10;

-- Aggregation
SELECT country, COUNT(*) as user_count
FROM users
GROUP BY country
HAVING COUNT(*) > 5;
```

### Client Libraries

- **Node.js**: `pg` (node-postgres), Prisma, Sequelize, Knex, TypeORM
- **Python**: `psycopg2`, SQLAlchemy
- **Go**: `pgx`, `database/sql`
- **Java**: JDBC PostgreSQL driver

---

## MySQL

### Enable

```env
MYSQL_ENABLED=true
MYSQL_PORT=3306
```

### Connect

```bash
mysql -h localhost -P 3306 -u root
```

### Supported SQL

Same as PostgreSQL (shared SQL translator). All standard SQL operations are supported.

### Client Libraries

- **Node.js**: `mysql2`, Sequelize, Knex, TypeORM
- **Python**: `mysql-connector-python`, SQLAlchemy
- **Go**: `go-sql-driver/mysql`
- **Java**: JDBC MySQL driver

---

## Redis

### Enable

```env
REDIS_ENABLED=true
REDIS_PORT=6379
```

### Connect

```bash
redis-cli -p 6379
```

### Supported Commands

| Category | Commands |
|----------|----------|
| String | `GET`, `SET`, `DEL`, `MGET`, `MSET`, `INCR`, `DECR`, `APPEND`, `STRLEN`, `SETNX` |
| Hash | `HSET`, `HGET`, `HGETALL`, `HDEL`, `HKEYS`, `HVALS`, `HEXISTS`, `HLEN` |
| List | `LPUSH`, `RPUSH`, `LPOP`, `RPOP`, `LLEN`, `LRANGE` |
| Set | `SADD`, `SREM`, `SMEMBERS`, `SISMEMBER`, `SCARD` |
| Key | `EXISTS`, `TYPE`, `KEYS`, `TTL`, `PTTL`, `PERSIST`, `EXPIRE`, `PEXPIRE` |
| Pub/Sub | `SUBSCRIBE`, `PUBLISH`, `UNSUBSCRIBE`, `PSUBSCRIBE` |
| Server | `PING`, `INFO`, `DBSIZE`, `FLUSHDB`, `SELECT`, `AUTH`, `COMMAND` |

### Pub/Sub (On-Chain)

When `MESSAGEBROKER_CONTRACT_ADDRESS` is configured, Redis `PUBLISH` and `SUBSCRIBE` commands are backed by on-chain events:

```bash
# Terminal 1: Subscribe
redis-cli -p 6379 SUBSCRIBE news

# Terminal 2: Publish (triggers on-chain transaction)
redis-cli -p 6379 PUBLISH news "Hello from Monad!"
```

See [Message Broker docs](../smart-contracts/message-broker.md) for details.

### Client Libraries

- **Node.js**: `ioredis`, `node-redis`
- **Python**: `redis-py`
- **Go**: `go-redis`
- **Java**: Jedis, Lettuce

---

## MongoDB

### Enable

Enabled by default. Disable with:

```env
MONGODB_ENABLED=false
```

### Connect

```bash
mongosh mongodb://localhost:27017
```

### Full MongoDB wire protocol compatibility as documented in the main README.

---

## HTTP REST API

Always enabled on the HTTP port.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health check |
| GET | `/metrics` | Prometheus metrics |
| GET | `/api/v1/collections` | List all collections |
| POST | `/api/v1/:collection/find` | Find documents |
| POST | `/api/v1/:collection/insert` | Insert documents |
| POST | `/api/v1/:collection/update` | Update documents |
| POST | `/api/v1/:collection/delete` | Delete documents |
| POST | `/api/v1/:collection/createIndex` | Create index |

This is a summary of core endpoints. The HTTP API includes 40+ endpoints covering authentication (SIWE), API key management, multi-protocol SQL/Redis, analytics, privacy, and more. See the **[full HTTP API Reference](../api-reference/http-api.md)** for complete documentation.

---

## Enabling Multiple Protocols

You can enable **any combination** of protocols simultaneously:

```env
# Enable all protocols
MONGODB_ENABLED=true
PG_ENABLED=true
MYSQL_ENABLED=true
REDIS_ENABLED=true
```

All protocols share the same DocumentStore and Monad backend. Data written via PostgreSQL is immediately readable via MongoDB, Redis, or HTTP.

## Custom Protocol (Bring Your Own Adapter)

To add a custom protocol frontend, implement the `ProtocolServerInstance` interface:

```typescript
import type { ProtocolServerInstance } from './protocols/protocol-manager';
import type { ProtocolType } from '@plugport/shared';
import net from 'net';

export class CustomProtocolServer implements ProtocolServerInstance {
    name: ProtocolType = 'custom' as any;
    server: net.Server | null = null;
    port: number;
    connections: number = 0;

    async start(): Promise<void> {
        // Create your protocol server
        this.server = net.createServer((socket) => {
            // Parse your protocol, translate to DocumentStore ops
        });
        this.server.listen(this.port);
    }

    async stop(): Promise<void> {
        this.server?.close();
        this.server = null;
    }

    getConnectionCount(): number {
        return this.connections;
    }
}
```

Register with the ProtocolManager:

```typescript
const customServer = new CustomProtocolServer({ store, port: 9999 });
protocolManager.register(customServer);
await customServer.start();
```
