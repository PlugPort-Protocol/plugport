<p align="center">
  <h1 align="center">PlugPort</h1>
  <p align="center">
    <strong>MongoDB-Compatible Document Store on MonadDb</strong>
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

PlugPort bridges the developer experience of MongoDB with the verifiable storage guarantees of MonadDb's Merkle Patricia Trie. Use familiar MongoDB drivers, queries, and tooling while your data is backed by blockchain-grade cryptographic proofs.

## Features

| Feature | Description |
|---------|-------------|
| **Wire Protocol** | Connect with `mongosh`, Node.js, Python, and Go MongoDB drivers |
| **HTTP API** | RESTful CRUD endpoints with JSON, API key auth, CORS |
| **Document Model** | BSON/JSON documents, auto-generated ObjectId, nested fields |
| **Indexing** | Single-field indexes with unique constraints, retroactive building |
| **Query Engine** | Filter ($gt, $gte, $lt, $lte, $eq, $ne, $in, $and), sort, projection, skip/limit |
| **Metrics** | Prometheus-compatible /metrics endpoint, JSON snapshot API |
| **Dashboard** | Next.js 15 UI with collection browser, query builder, index manager |
| **CLI** | `plugport init`, `plugport dev`, `plugport playground` for rapid development |
| **SDKs** | Node.js, Python (PyMongo shim), Go (mongo-go-driver compatible) |
| **Free Tier** | Deployable on Vercel, Railway, Render, Docker Hub |

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
- **HTTP API**: `http://localhost:8080`
- **Wire Protocol**: `mongodb://localhost:27017`
- **Health**: `http://localhost:8080/health`

### Using the CLI

```bash
# Initialize a new project
npx @plugport/cli init

# Start development server with playground data
npx @plugport/cli playground

# Query from command line
npx @plugport/cli query users --filter '{"age": {"$gte": 25}}'
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

```
                    +-------------------+
                    |    Client Apps     |
                    +---+-----------+---+
                        |           |
              Wire Protocol     HTTP API
              (port 27017)    (port 8080)
                        |           |
                    +---+-----------+---+
                    |   PlugPort Core    |
                    |                   |
                    | +---------------+ |
                    | | Document Store| |
                    | +-------+-------+ |
                    |         |         |
                    | +-------+-------+ |
                    | | Query Planner | |
                    | | Index Manager | |
                    | +-------+-------+ |
                    |         |         |
                    | +-------+-------+ |
                    | |  Key Encoding | |
                    | +-------+-------+ |
                    |         |         |
                    | +-------+-------+ |
                    | |  KV Adapter   | |
                    | +-------+-------+ |
                    +---+-----+-----+---+
                        |           |
              In-Memory KV    MonadDb RPC
              (dev mode)      (production)
```

**Key Design Decisions:**
- **Sort-preserving key encoding** using IEEE 754 bit manipulation for numbers
- **Pluggable KV adapter** - swap in-memory for MonadDb without code changes
- **Retroactive index building** - create indexes on existing collections
- **MongoDB error codes** - E11000 duplicate key, namespace errors, etc.

## SDKs

### Node.js SDK

```typescript
import { PlugPortClient } from '@plugport/sdk';

const client = await PlugPortClient.connect('http://localhost:8080');
const db = client.db('myapp');
const users = db.collection('users');

// Insert
await users.insertOne({ name: 'Alice', email: 'alice@example.com', age: 30 });

// Find with operators
const admins = await users.find({ role: 'admin', age: { $gte: 21 } });

// Update
await users.updateOne({ name: 'Alice' }, { $set: { age: 31 } });

// Index
await users.createIndex('email', { unique: true });

await client.close();
```

### Python SDK

```python
from plugport import PlugPortClient

# PyMongo-compatible API
client = PlugPortClient("http://localhost:8080")
db = client["myapp"]
users = db["users"]

# Insert
result = users.insert_one({"name": "Alice", "email": "alice@example.com"})

# Find
docs = users.find({"name": "Alice"})

# Context manager support
with PlugPortClient("http://localhost:8080") as client:
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

- **Overview** - Server status, collection stats, performance metrics, MonadDb architecture
- **Collection Browser** - Browse all collections, insert documents, view stats
- **Query Builder** - Visual query construction with filter, projection, sort, limit
- **Document Explorer** - Browse, edit, and delete individual documents
- **Index Manager** - Create and drop indexes, view index definitions
- **Metrics** - Real-time QPS, latency percentiles, protocol distribution, storage

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

### Wire Protocol Commands

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
│   ├── shared/          # Shared types (KVAdapter, Filter, Config)
│   ├── server/          # Core server (HTTP + Wire + Storage)
│   │   └── src/
│   │       ├── storage/     # KV adapter, key encoding, indexes, query planner
│   │       ├── http-server  # Fastify HTTP API
│   │       ├── wire-server  # MongoDB wire protocol (OP_MSG)
│   │       ├── metrics      # Prometheus metrics
│   │       └── index        # Server bootstrap
│   ├── sdk/             # Node.js SDK
│   ├── cli/             # CLI tool
│   └── dashboard/       # Next.js 15 dashboard
├── sdks/
│   ├── python/          # Python SDK (PyMongo shim)
│   └── go/              # Go client library
├── demos/
│   ├── ecommerce/       # E-commerce demo (cart, checkout)
│   └── chat/            # Real-time chat (WebSocket + PlugPort)
├── tests/
│   ├── integration/     # HTTP API integration tests
│   └── load/            # k6 load test scripts
├── docs/               # Docusaurus documentation site
├── deploy/
│   ├── docker/          # Dockerfiles + docker-compose
│   ├── k8s/             # Kubernetes manifests
│   └── terraform/       # Terraform templates
├── .env.example         # Environment variable template
└── .github/
    └── workflows/       # CI/CD + Docs deploy
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HTTP_PORT` | `8080` | HTTP API port |
| `WIRE_PORT` | `27017` | Wire protocol port |
| `HOST` | `0.0.0.0` | Bind address |
| `API_KEY` | none | API key for authentication |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |
| `METRICS_ENABLED` | `true` | Enable Prometheus metrics |
| `MONADDB_ENDPOINT` | none | MonadDb RPC endpoint (uses in-memory if unset) |
| `MONADDB_PRIVATE_KEY` | none | Server wallet private key (64 hex chars, no 0x prefix) |
| `MAX_DOC_SIZE` | `1048576` | Maximum document size in bytes (1MB) |

> See `.env.example` for a fully commented template. Each package also has its own `.env.example`.

## Why MonadDb?

MonadDb provides the ideal storage substrate for a document database:

1. **Merkle Patricia Trie** - Every write produces a cryptographic proof. Documents are verifiable without trusting the server.
2. **Sorted Key Space** - Lexicographic ordering enables efficient range scans, which PlugPort leverages for index-based queries.
3. **10,000 TPS** - Monad's parallel execution layer supports high-throughput document operations.
4. **State Proofs** - Clients can verify query results against the trie root hash.

## Documentation

Full documentation is available at [plugport.github.io/plugport](https://plugport.github.io/plugport/) (Docusaurus).

Or preview locally:

```bash
cd docs && npm install && npm start
```

## License

MIT

---

<p align="center">
  Built for <a href="https://monad.xyz">Monad</a> ecosystem
</p>
