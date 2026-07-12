<p align="center">
  <h1 align="center">PlugPort</h1>
  <p align="center">
    <strong>Web3 protocol port for every database - Apps to dApps in seconds!</strong>
  </p>
  <p align="center">
    <a href="#features">Features</a> |
    <a href="#quick-start">Quick Start</a> |
    <a href="#architecture">Architecture</a> |
    <a href="#sdks">SDKs</a> |
    <a href="#dashboard">Dashboard</a> |
    <a href="#api-reference">API Reference</a> |
    <a href="#deployment">Deployment</a>
  </p>
</p>

---

PlugPort is a Web3 protocol port for every major database. It helps developers convert traditional Web2 Apps into dApps seamlessly by providing drop-in compatibility for MongoDB, PostgreSQL, MySQL, Redis, and SQLite. Built on MonadDb's Merkle Patricia Trie, it offers verifiable storage by default—giving you cryptographic trust while letting you keep your familiar drivers and tools. All protocols interact with the same underlying document store using a unified translation layer.

## Features

| Feature | Description |
|---------|-------------|
| **Multi-Protocol** | Connect with `mongosh`, `psql`, `mysql`, `redis-cli`, and their respective Node.js/Python/Go drivers |
| **HTTP API** | RESTful CRUD endpoints for all protocols (e.g. `/api/v1/sql`, `/api/v1/redis`) |
| **Aggregation Pipeline** | Full `$lookup`, `$match`, `$project`, `$sort`, `$limit`, `$skip`, `$unwind`, `$count` support (max 50 stages) |
| **Transactions** | Best-effort transactions: buffered writes, sequential flush on commit, discard on abort |
| **Pub/Sub SSE** | Real-time messaging via Redis Pub/Sub mapping to HTTP Server-Sent Events (`/api/v1/redis/stream`) |
| **Web3 Native Auth** | SIWE + wallet-derived API keys + SCRAM-SHA-256 with on-chain `PlugPortAuth` contract + gasless meta-transactions |
| **Smart Contract RBAC** | On-chain Role-Based Access Control (`PlugPortPrivateStore`) for granular read/write permissions |
| **Encryption** | AES-256-GCM encryption with ECDH key sharing for private collections |
| **Join Engine** | Hash, Left, Right, and Cross joins for SQL and NoSQL aggregations |
| **Dashboard** | Next.js 15 UI with universal protocol pivot, 3-way scoped metrics (Global/Personal/Comparison), query builder, and privacy toggles |
| **CLI & SDKs** | Node.js, Python, Go clients plus a developer-friendly `plugport` CLI |

## Quick Start

### Install and Run

```bash
# Clone and install
git clone https://github.com/plugport/plugport.git
cd plugport
cp .env.example .env   # Optional: configure ports, auth, MonadDb
pnpm install
pnpm -r build

# Start the server (dev mode - in-memory storage)
pnpm --filter @plugport/server dev
```

Server starts on:
- **HTTP API**: `http://localhost:8080` (Includes `/api/v1/sql`, `/api/v1/redis`, `/api/v1/redis/stream`)
- **Mongo Wire Protocol**: `mongodb://localhost:27017`
- **Postgres Wire Protocol**: `postgresql://localhost:5432`
- **Redis Protocol**: `redis://localhost:6379`
- **Health**: `http://localhost:8080/health`

### Using the CLI

```bash
# Initialize a new project
npx @plugport/cli init

# Start development server with playground data
npx @plugport/cli playground

# Query from command line
npx @plugport/cli query users --filter '{"age": {"$gte": 25}}'

# Run an aggregation pipeline
npx @plugport/cli aggregate orders --pipeline '[{"$match": {"status": "completed"}}, {"$lookup": {"from": "users", "localField": "userId", "foreignField": "_id", "as": "user"}}]'
```

### Using Docker

```bash
# Single server
docker run -p 8080:8080 -p 27017:27017 plugport/server

# Full stack (server + dashboard + Prometheus + Grafana)
cd deploy/docker
docker-compose up
```

## Architecture

```text
                    +-----------------------------------+
                    |           Client Apps             |
                    +---+-------+-------+-------+-------+
                        |       |       |       |       |
                      Mongo   PG/MySQL Redis   HTTP    SSE
                        |       |       |       |       |
                    +---+-------+-------+-------+-------+
                    |        PlugPort Protocol Hub       |
                    |  (SIWE Auth, API Keys, Routing)    |
                    +-----------------------------------+
                    |         Translation Layer          |
                    | (SQL/Redis/Mongo -> Monad Query)   |
                    +-----------------------------------+
                    |          PlugPort Core             |
                    |                                   |
                    | +---------------+ +-------------+ |
                    | | Document Store| | Join Engine | |
                    | +-------+-------+ +-------------+ |
                    |         |                         |
                    | +-------+-------+ +-------------+ |
                    | | Index Manager | | Crypto Layer| |
                    | +-------+-------+ +-------------+ |
                    |                                   |
                    | +-------+-------+                 |
                    | | RoutingAdapter|                 |
                    | +-------+-------+                 |
                    +---+-----+-----+---+
                        |           |
            +-----------+           +-----------+
            |                                   |
      +-----+-----+                       +-----+-----+
      |Public Base|                       |Private Base|
      |(In-Memory)|                       |(Encryption)|
      +-----------+                       +-----------+
            |                                   |
            +-----------------------------------+
                              |
                         MonadDb RPC
                      (Smart Contracts)
                       - PlugPortStore.sol
                      - PlugPortPrivateStore.sol
                      - PlugPortMessageBroker.sol
                      - PlugPortAuth.sol
```

**Key Design Decisions:**
- **Unified Translation Layer**: Maps SQL, Redis, and Mongo commands into a universal DocumentStore AST.
- **Triple-Auth Strategy**: Connect securely via Web3 Wallets (SIWE), rotating API keys, or legacy IP whitelists.
- **Smart Contract RBAC**: Granular on-chain rules (`accessRoles`) dictate read/write access per collection/user via `PlugPortPrivateStore.sol`.
- **Pluggable KV adapter** - swap in-memory for MonadDb without code changes.
- **Join Engine** - Executes fast cross-collection joins for relational queries.

## SDKs

### Node.js SDK

```typescript
import { PlugPortClient } from '@plugport/sdk';

const client = await PlugPortClient.connect('http://localhost:8080', {
    apiKey: 'pp_test_1234567890abcdef',
});
const db = client.db('myapp');
const users = db.collection('users');

// Insert
await users.insertOne({ name: 'Alice', email: 'alice@example.com', age: 30 });

// Find with operators
const admins = await users.find({ role: 'admin', age: { $gte: 21 } });

// Update
await users.updateOne({ name: 'Alice' }, { $set: { age: 31 } });

// Role-Based Access Control (RBAC)
await users.grantRole('0x123...', 2); // 1 = Read, 2 = Write
await users.revokeRole('0x123...');

// Index
await users.createIndex('email', { unique: true });

await client.close();
```

### Python SDK

```python
from plugport import PlugPortClient

# PyMongo-compatible API
client = PlugPortClient("http://localhost:8080", api_key="pp_test_1234567890abcdef")
db = client["myapp"]
users = db["users"]

# Insert
result = users.insert_one({"name": "Alice", "email": "alice@example.com"})

# Find
docs = users.find({"name": "Alice"})

# RBAC
users.grant_role("0x123...", 2)

# Context manager support
with PlugPortClient("http://localhost:8080", api_key="pp_...") as client:
    db = client["myapp"]
```

### Go SDK

```go
client, err := plugport.Connect("http://localhost:8080")
defer client.Close()

coll := client.Database("myapp").Collection("users")

// Insert
result, _ := coll.InsertOne(ctx, map[string]interface{}{
    "name": "Alice",
    "email": "alice@example.com",
})

// Find
docs, _ := coll.Find(ctx, map[string]interface{}{"name": "Alice"})
```

### Wire Protocol (mongosh)

```bash
mongosh mongodb://localhost:27017

> use myapp
> db.users.insertOne({ name: "Alice", age: 30 })
> db.users.find({ age: { $gte: 25 } })
> db.users.createIndex({ email: 1 }, { unique: true })
```

## Dashboard

The built-in Next.js dashboard provides:

- **Universal Pivot**: Toggle seamlessly between "All Collections" and "My Collections" (filtered by your SIWE wallet).
- **3-Way Scoped Metrics**: Compare Global vs Personal vs Side-by-Side metrics for QPS, latency, and distribution.
- **API Key Management**: Generate, rotate, and revoke scoped API keys.
- **Privacy & ACL**: Toggle public/private modes and manage granular roles (Read/Write) stored on-chain.
- **Multi-Protocol Queries**: Run queries in MongoDB, PostgreSQL, Redis, or SQLite dialects via the Query Builder.
- **Document Explorer**: Browse, edit, delete, import, and export individual documents.

```bash
# Start dashboard
pnpm --filter @plugport/dashboard dev
# Open http://localhost:3000
```

## API Reference

### HTTP Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server health check |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/api/v1/metrics` | JSON metrics snapshot |
| `GET` | `/api/v1/collections` | List all collections |
| `POST` | `/api/v1/collections/:name/insertOne` | Insert one document |
| `POST` | `/api/v1/collections/:name/insertMany` | Insert multiple documents |
| `POST` | `/api/v1/collections/:name/find` | Find documents |
| `POST` | `/api/v1/collections/:name/findOne` | Find one document |
| `POST` | `/api/v1/collections/:name/updateOne` | Update one document |
| `POST` | `/api/v1/collections/:name/deleteOne` | Delete one document |
| `POST` | `/api/v1/collections/:name/deleteMany` | Delete many documents |
| `POST` | `/api/v1/collections/:name/createIndex` | Create an index |
| `POST` | `/api/v1/collections/:name/dropIndex` | Drop an index |
| `GET` | `/api/v1/collections/:name/indexes` | List indexes |
| `GET` | `/api/v1/collections/:name/stats` | Collection statistics |
| `POST` | `/api/v1/collections/:name/drop` | Drop a collection |

### MongoDB Wire Protocol Commands

| Command | Status |
|---------|--------|
| `hello` / `isMaster` | Supported |
| `ping` | Supported |
| `insert` | Supported |
| `find` | Supported |
| `update` | Supported |
| `delete` | Supported |
| `createIndexes` | Supported |
| `listCollections` | Supported |
| `buildInfo` | Supported |
| `aggregate` (basic) | Supported |
| `count` | Supported |
| `distinct` | Supported |
| `saslStart/Continue` | Placeholder |

### Query Operators

| Operator | Example |
|----------|---------|
| `$eq` | `{ age: { $eq: 30 } }` |
| `$ne` | `{ status: { $ne: "inactive" } }` |
| `$gt` | `{ age: { $gt: 25 } }` |
| `$gte` | `{ age: { $gte: 18 } }` |
| `$lt` | `{ price: { $lt: 100 } }` |
| `$lte` | `{ score: { $lte: 50 } }` |
| `$in` | `{ role: { $in: ["admin", "mod"] } }` |
| `$and` | `{ $and: [{ age: { $gte: 18 } }, { status: "active" }] }` |
| implicit AND | `{ age: { $gte: 18 }, status: "active" }` |

## Testing

```bash
# Unit tests
pnpm --filter @plugport/server test

# Integration tests (requires running server)
pnpm --filter @plugport/server dev &
pnpm --filter @plugport/tests test:integration

# MongoDB compatibility suite
pnpm --filter @plugport/tests test:compat

# Load tests (requires k6)
k6 run tests/load/crud-mix.js
```

## Deployment

### Docker Compose (Recommended)

```bash
cd deploy/docker
docker-compose up -d
```

Services:
- **Server**: `http://localhost:8080` (HTTP) + `mongodb://localhost:27017` (Wire)
- **Dashboard**: `http://localhost:3000`
- **Prometheus**: `http://localhost:9090`
- **Grafana**: `http://localhost:3001` (admin/plugport)

### Kubernetes

```bash
kubectl apply -f deploy/k8s/plugport.yaml
```

Includes: Namespace, ConfigMap, Deployment (2 replicas), Services, Ingress, HPA.

### Terraform

```bash
cd deploy/terraform
terraform init
terraform apply
```

### Free Tier Deployment

| Service | What It Runs | Free Tier |
|---------|-------------|-----------|
| [Railway](https://railway.app) | Server + Wire Protocol | 500hrs/month |
| [Vercel](https://vercel.com) | Dashboard (Next.js) | Unlimited |
| [Docker Hub](https://hub.docker.com) | Container images | Public repos |
| [npm](https://npmjs.com) | SDK packages | Public packages |
| [GitHub Actions](https://github.com/features/actions) | CI/CD pipeline | 2000 min/month |

## Project Structure

```
plugport/
├── packages/
│   ├── shared/              # Shared types & interfaces (KVAdapter, Filter, Config)
│   ├── server/              # Core server
│   │   └── src/
│   │       ├── auth/            # SIWE sessions, API key manager, analytics, on-chain auth contract adapter (registerKeyMeta, revokeKeyMeta, rotateKeyMeta)
│   │       ├── storage/         # Document store, KV adapter, index manager,
│   │       │                    # query planner, encryption layer, routing adapter,
│   │       │                    # MonadDb adapter, privacy manager, message broker
│   │       ├── protocols/       # Multi-protocol wire servers
│   │       │   ├── pg-server        # PostgreSQL wire protocol
│   │       │   ├── mysql-server     # MySQL wire protocol
│   │       │   ├── redis-server     # Redis wire protocol (RESP)
│   │       │   ├── sql-translator   # SQL → Document Store AST
│   │       │   ├── join-engine      # Cross-collection joins
│   │       │   └── protocol-manager # Protocol lifecycle orchestrator
│   │       ├── http-server      # Fastify HTTP REST API
│   │       ├── wire-server      # MongoDB wire protocol (OP_MSG)
│   │       ├── metrics          # Prometheus metrics exporter
│   │       └── index            # Server bootstrap
│   ├── sdk/                 # Node.js SDK (@plugport/sdk)
│   ├── cli/                 # CLI tool (@plugport/cli)
│   ├── sqlite-compat/       # Drop-in better-sqlite3 replacement
│   └── dashboard/           # Next.js 15 dashboard (RainbowKit + SIWE)
├── sdks/
│   ├── python/              # Python SDK (PyMongo-compatible shim)
│   └── go/                  # Go client library
├── contracts/               # Solidity smart contracts
│   ├── PlugPortStore.sol        # Core document storage contract
│   ├── PlugPortPrivateStore.sol # Encrypted private collections + RBAC
│   ├── PlugPortAuth.sol         # On-chain auth: wallet-derived API keys + SCRAM-SHA-256 verifiers + gasless meta-tx (register, revoke, rotate)
│   ├── PlugPortPrivateStoreFactory.sol
│   ├── PlugPortRelational.sol   # Relational data contract
│   └── PlugPortMessageBroker.sol # On-chain Pub/Sub message broker
├── demos/
│   ├── ecommerce/           # E-commerce demo (Express + @plugport/sdk)
│   └── chat/                # Real-time chat (WebSocket + @plugport/sdk)
├── tests/
│   ├── integration/         # HTTP API + MongoDB compatibility tests
│   └── load/                # k6 load test scripts (crud-mix.js)
├── docs/                    # Docusaurus documentation site (wiki.plugport.wtf)
├── deploy/
│   ├── docker/              # Dockerfiles + docker-compose
│   ├── k8s/                 # Kubernetes manifests
│   └── terraform/           # Terraform templates
├── audits/                  # Security & code audit reports
├── .github/
│   └── workflows/
│       ├── ci.yml               # CI pipeline (lint, test, build)
│       └── deploy-docs.yml      # Docusaurus → GitHub Pages deployment
├── .env.example             # Environment variable template
├── .env.testnet.example     # Monad testnet configuration
├── .env.mainnet.example     # Monad mainnet configuration
├── pnpm-workspace.yaml      # Workspace package definitions
├── tsconfig.json            # Root TypeScript config
└── eslint.config.mjs        # ESLint flat config
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HTTP_PORT` | `8080` | HTTP API port |
| `HOST` | `0.0.0.0` | Bind address |
| `API_KEY` | none | API key for authentication |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |
| `METRICS_ENABLED` | `true` | Enable Prometheus metrics |
| `MAX_DOC_SIZE` | `1048576` | Maximum document size in bytes (1MB) |
| `IS_TESTNET` | `true` | Testnet mode flag |
| `DASHBOARD_URL` | none | Dashboard URL for CORS origin locking |
| **Protocol Toggles** | | |
| `MONGODB_ENABLED` | `true` | Enable MongoDB wire protocol |
| `WIRE_PORT` | `27017` | MongoDB wire protocol port |
| `PG_ENABLED` | `false` | Enable PostgreSQL wire protocol |
| `PG_PORT` | `5432` | PostgreSQL wire protocol port |
| `MYSQL_ENABLED` | `false` | Enable MySQL wire protocol |
| `MYSQL_PORT` | `3306` | MySQL wire protocol port |
| `REDIS_ENABLED` | `false` | Enable Redis wire protocol |
| `REDIS_PORT` | `6379` | Redis wire protocol port |
| **Monad Configuration** | | |
| `MONAD_RPC_URL` | none | Monad RPC endpoint (uses in-memory if unset) |
| `MONAD_CHAIN_ID` | `10143` | Monad chain ID |
| `MONAD_PRIVATE_KEY` | none | Gas station wallet key (64 hex chars, no 0x) |
| `MONAD_CONTRACT_ADDRESS` | none | Deployed PlugPortStore contract address |

> See `.env.example`, `.env.testnet.example`, and `.env.mainnet.example` for fully commented templates.

## Why MonadDb?

MonadDb provides the ideal storage substrate for a document database:

1. **Merkle Patricia Trie** - Every write produces a cryptographic proof. Documents are verifiable without trusting the server.
2. **Sorted Key Space** - Lexicographic ordering enables efficient range scans, which PlugPort leverages for index-based queries.
3. **10,000 TPS** - Monad's parallel execution layer supports high-throughput document operations.
4. **State Proofs** - Clients can verify query results against the trie root hash.

## Documentation

Full documentation is available at [wiki.plugport.wtf](https://wiki.plugport.wtf).

Or preview locally:

```bash
cd docs && npm install && npm start
```

## License

Business Source License 1.1 (BSL-1.1)

---

<p align="center">
  Built for <a href="https://monad.xyz">Monad</a> ecosystem
</p>
