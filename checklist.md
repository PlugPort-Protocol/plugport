# PlugPort - Full Project Build Checklist

## Phase 1: Core Service Layer
- [x] Project scaffolding (monorepo structure, package.json, tsconfig)
- [x] Storage engine (in-memory KV adapter mimicking MonadDb, key encoding)
- [x] Document model (BSON/JSON handling, ObjectId generation, validation)
- [x] Index maintenance logic (insert/update/delete index keys)
- [x] Query planner (index selection, range scans, collection scan fallback)
- [x] Command layer (InsertCommand, FindCommand, UpdateCommand, DeleteCommand)
- [x] HTTP API server (Fastify, all CRUD + index + health + count + distinct endpoints)
- [x] Wire-protocol server (TCP/27017, OP_MSG parser, BSON, handshake)
- [x] Auth shim (API key for HTTP, SASL PLAIN for wire protocol)

## Phase 2: Client & Integration Layer
- [x] Node.js SDK (@plugport/sdk) with MongoDB driver shim
- [x] TypeScript type definitions
- [x] Python SDK (pymongo shim)
- [x] Go client library

## Phase 3: Frontend & Demo Layer
- [x] Next.js 15 Dashboard (collection browser, query builder, index manager, metrics)
- [x] CLI tool (plugport-cli with playground command)
- [x] E-commerce demo app
- [x] Chat app demo

## Phase 4: Testing Suite
- [x] Unit tests (storage, encoding, index, command validation) — 116/116 passing
- [x] Integration tests (HTTP API E2E, wire protocol)
- [x] Compatibility suite (MongoDB operation matrix)
- [x] Load tests (k6/Artillery scripts)

## Phase 5: Operations & Deployment
- [x] Dockerfiles and docker-compose
- [x] Helm chart / K8s manifests
- [x] Prometheus metrics exporter + Grafana dashboards
- [x] Terraform templates (AWS/GCP)

## Phase 6: Documentation & DX
- [x] Comprehensive README
- [x] CI/CD pipeline (GitHub Actions)
- [x] Docusaurus docs site (GitHub Pages)
  - [x] Getting Started / Quick Start
  - [x] Migration Guide (MongoDB to PlugPort)
  - [x] Architecture Deep Dive
  - [x] Node.js SDK Reference
  - [x] Python SDK Reference
  - [x] Go SDK Reference
  - [x] HTTP API Reference
  - [x] Wire Protocol Reference
  - [x] Deployment Guide
  - [x] GitHub Pages deploy workflow

## Phase 7: Branding & Assets
- [x] Rebrand from TrieDBX to PlugPort (all code, configs, packages)
- [x] Logo assets (favicon, square logo, logo with text)
- [x] Dashboard logo integration
- [x] Docusaurus navbar + hero logo
- [x] ASCII startup banner (PlugPort)
- [x] `.gitignore` hardened for monorepo

## Phase 8: Security Audit
- [x] Prototype pollution prevention (`sanitizeDocument` on all inputs including `$inc`/`$unset`)
- [x] DoS mitigations (rate limiting, body size limits, query limits)
- [x] Timing attack prevention (constant-time `timingSafeEqual` for API keys + SASL auth)
- [x] Stack overflow protection (`sanitizeDocument` depth=20, `normalizeDocument` depth=20)
- [x] Unbounded `$in`/`$nin` array cap (2000 elements)
- [x] Index key length cap (1024 characters)
- [x] Wire protocol message size cap (48MB)
- [x] Wire protocol buffer accumulation OOM cap
- [x] Slowloris protection (60s socket timeout)
- [x] BSON deserialization depth limits
- [x] Dead code removal (unreachable `saslContinue` return)

## Phase 9: Query & Update Operators
- [x] `$set` — set field values
- [x] `$inc` — increment numeric fields
- [x] `$unset` — remove fields from documents
- [x] `$eq`, `$ne` — equality / inequality
- [x] `$gt`, `$gte`, `$lt`, `$lte` — range comparisons
- [x] `$in` — match any value in array
- [x] `$nin` — exclude values in array
- [x] `$and` — logical AND across sub-filters
- [x] `$or` — logical OR across sub-filters (with index optimization)
- [x] `$exists` — check field existence

## Phase 10: API & SDK Completeness
- [x] HTTP `insertOne` / `insertMany`
- [x] HTTP `find` / `findOne`
- [x] HTTP `updateOne` / `updateMany` (with `$set`/`$inc`/`$unset`)
- [x] HTTP `deleteOne` / `deleteMany`
- [x] HTTP `count` (server-side, bypasses query limit cap)
- [x] HTTP `distinct`
- [x] HTTP `createIndex` / `dropIndex` / `listIndexes`
- [x] HTTP `stats` / `health` / `metrics`
- [x] Wire protocol full CRUD + aggregation + count + distinct
- [x] Node.js SDK: `updateMany`, `countDocuments` (server-side), `distinct`
- [x] Python SDK: `update_many`, `count_documents` (server-side), `distinct`, `estimated_document_count`
- [x] SDK retry logic (429 backoff) for Node.js and Python

## Phase 11: Performance & Robustness
- [x] Chunked insert/update/delete (BATCH_LIMIT=5000) to prevent OOM
- [x] Query limits (DEFAULT=1000, MAX=5000, SORT_EVAL=50000)
- [x] `listCollections` scan capped at 1000
- [x] Mutex-based collection locks for race condition prevention
- [x] Two-phase commit for unique index checks (with self-exclusion on update)
- [x] Metrics collector with bounded tracking (MAX_TRACKED_COMMANDS=100, MAX_TRACKED_ERRORS=100)
- [x] `extractCommand` properly tracks all endpoints (insert/find/findOne/update/updateMany/delete/count/distinct/index)

## Phase 12: V3 Multi-Protocol & Core Engines
- [x] Multi-protocol middleware support (MongoDB, PostgreSQL, MySQL, Redis, SQLite)
- [x] SQL Translation Layer for PostgreSQL/MySQL text protocol mapping
- [x] JoinEngine (Hash, Left, Right, Cross joins) resolving relational operations
- [x] `@plugport/sqlite-compat` SDK acting as drop-in replacement for better-sqlite3
- [x] AES-256-GCM Encryption Layer with ECDH key sharing for private mode

## Phase 13: V3 Smart Contracts & RBAC
- [x] `PlugPortPrivateStore` contract for encrypted storage and Access Control Lists (ACL)
- [x] `PlugPortMessageBroker` contract powering on-chain Pub/Sub
- [x] `PlugPortRelational` contract enabling batchGet for O(1) JOIN resolutions
- [x] Role-Based Access Control (RBAC) migration across HTTP endpoints and SDKs
- [x] Go, Python, Node, and sqlite-compat SDKs updated to securely pass `x-api-key` headers and trigger `.grantRole()` operations
- [x] Strong typings for RBAC exported via `@plugport/shared` (`RoleGrantPayload`, `CollectionPrivacy`)

## Phase 14: V3 Dashboard, SSE, & Ecosystem
- [x] Next.js Dashboard pivot to Universal Wallet Auth & API Keys
- [x] Protocols Tab (Dialect UI toggles) and Privacy & ACL controls
- [x] 3-way scoping metrics (Global vs Personal vs Split-View comparison)
- [x] Server-Sent Events (SSE) implemented for real-time Pub/Sub streams
- [x] Collection JSON import feature added to UI
- [x] Hardcoded `.env` values (`IS_TESTNET`) removed and `.env.example` deeply audited
- [x] CI parity achieved via `start-server-and-test`
- [x] Comprehensive documentation/README rewrites covering Multi-Protocol & SIWE

## Phase 15: V3 Isolated Privacy Channels
- [x] Implemented `RoutingAdapter` proxying real-time traffic to parallel public and private storage channels
- [x] Cleaned up `EncryptionLayer` strictly handling AES-256-GCM logic without circular dependencies
- [x] Discarded global `STORAGE_MODE` config enabling granular dynamic per-collection privacy configurations
- [x] Cleaned `.env.example`s across the entire stack ensuring precise `PRIVATE_STORE_CONTRACT` onboarding

## Phase 16: SIWE + iron-session Auth Refactor
- [x] Replaced custom `siwe-handler.ts` (JWT + in-memory nonce) with `siwe` package + `iron-session` encrypted cookies
- [x] Session secret derived from `MONAD_PRIVATE_KEY` via HMAC-SHA256 — zero new env vars
- [x] Added `@fastify/cookie` for cookie parsing, locked CORS to `DASHBOARD_URL` with `credentials: true`
- [x] Dashboard uses official `SiweMessage` class for EIP-4361, cookie-based auth flow
- [x] Added `/auth/logout` endpoint for explicit session destruction
- [x] Removed `jose` dependency, `setAuthToken()`, and all JWT/localStorage patterns

## Phase 17: Security Audit Hotfixes (S2–S6, B7)
- [x] Access control enforced on `count` and `distinct` endpoints via `checkAccess()`
- [x] User-scoped endpoints (`user/:address/*`) guarded with auth + ownership verification
- [x] Owner spoofing prevented in `deploy/register` — always uses authenticated address
- [x] Gas station balance endpoint requires auth + validates Ethereum address format
- [x] Privacy mode changes restricted to collection owner only
- [x] BigInt precision fix for MON balance conversion in gas station endpoint

## Phase 18: Bug Fixes (B1–B6)
- [x] Light mode CSS tokens (`--radius-*`, `--transition-*`, `--sidebar-width`) moved to `:root`
- [x] `btn-primary` / `btn-secondary` hardcoded colors replaced with theme-aware variables
- [x] `InMemoryKVStore.batchWrite()` implemented for dev mode correctness
- [x] `RoutingAdapter` diagnostic metrics now include both public + private storage channels
- [x] RainbowKit theme synced with `next-themes` (light/dark mode)
- [x] `EncryptionLayer.scan()` logs warnings on decryption failures

## Phase 19: Architecture & DevEx (A1–A7)
- [x] Created shared `types.ts` for dashboard, then fully decomposed `page.tsx` monolith (2,114→253 lines) into 12 component files
- [x] CI pipeline triggers fixed to include `v3` branch
- [x] `PrivacyManager.listOwnedCollections` scan bounded with `limit: 10000`
- [x] SIWE nonce store issue resolved (iron-session cookies, no in-memory Map)
- [x] Whitelist management persisted to KV store (survives restarts)
- [x] `RoutingAdapter.scan()` and `count()` merge public + private results for global operations

## Phase 20: Residual Fixes (R1–R3)
- [x] Bounded `GET /deploy/contracts` scan with `limit: 10000`
- [x] Dashboard `page.tsx` imports all types from shared `types.ts` — inline types removed
- [x] Fixed 3 pre-existing `monaddb-adapter.test.ts` failures (RoutingAdapter wrapping assertions)

## Phase 21: Test Coverage (T1–T4)
- [x] Access control integration tests (8 tests: count/distinct ACL, user auth, gas station auth)
- [x] RoutingAdapter routing logic tests (15 tests: privacy routing, global merge, dedup, batch write)
- [x] CSS correctness verified via dashboard build (no unit-level visual regression)
- [x] InMemoryKVStore batchWrite tests (7 tests: multi-key ops, Uint8Array, edge cases)

## Phase 22: Improvements (I1–I10)
- [x] `page.tsx` monolith fully decomposed: 10 tab components + `ScopeToggle` extracted into `components/` directory with barrel re-export (88% line reduction)
- [x] I2 N/A: JWT replaced by iron-session — no `JWT_SECRET` needed
- [x] PrivacyManager TTL cache (30s) eliminates repeated KV reads per request
- [x] Silent `catch {}` blocks audited — structured `console.warn` added to critical paths

## Phase 23: 2nd Audit Fixes (T3, R1–R3, N1–N6)
- [x] **R1–R3**: Silent catch blocks in `monaddb-adapter.ts`, `routing-adapter.ts`, and `http-server.ts` now log `console.warn` with structured context
- [x] **N1**: `GET /collections/:name/roles` requires auth + collection ownership (401/403)
- [x] **N2**: `GET /collections/:name/privacy` returns reduced payload for non-owners (no ACL/contract leaked)
- [x] **N3**: `POST /api/v1/whitelist` requires authentication (401)
- [x] **N4**: `POST /collections/:name/roles` validates ownership at HTTP layer with 404/403 error handling
- [x] **N5**: Integration test cleanup passes owner auth header — `afterAll` drop no longer silently fails
- [x] **N6**: Balance endpoint uses pure BigInt string arithmetic — no `Number()` precision loss at any scale
- [x] **T3**: 18 CSS token validation tests added to dashboard (`css-tokens.test.ts` + `vitest.config.ts`)
- [x] Test suite updated for new auth requirements: `access-control.test.ts` (+3 tests), `protocol-integration.test.ts` (whitelist auth headers)

## Phase 24: Auth Hardening (Rate Limiting + CSRF)
- [x] Per-route rate limits on auth endpoints: `/auth/nonce` (10/min), `/auth/verify` (5/min), `/auth/me` (30/min), `/auth/logout` (10/min)
- [x] Double-submit CSRF cookie pattern for session-authenticated (SIWE) mutations
- [x] CSRF token generated on `/auth/verify`, stored in encrypted session + non-httpOnly `plugport_csrf` cookie
- [x] `onRequest` middleware validates `x-csrf-token` header on POST/PUT/DELETE for cookie-authed users
- [x] API key auth, test backdoor, and GET/HEAD/OPTIONS exempt from CSRF
- [x] Dashboard `api.ts` reads `plugport_csrf` cookie and attaches `x-csrf-token` header on mutations
- [x] CSRF cookie cleared on `/auth/logout` alongside session destruction
- [x] Auth security tests: 5 new tests (rate limit 429 enforcement, CSRF exemptions)

## Phase 25: Redis Command Expansion (HMSET, HMGET, RENAME)
- [x] Implemented `HMSET` — multi-field hash write (merges into existing hash document in KV store)
- [x] Implemented `HMGET` — multi-field hash read (returns array of values, `nil` for missing fields)
- [x] Implemented `RENAME` — atomic key rename across all data types (string, hash, list, set, sorted set)
- [x] Updated protocols documentation with HMSET/HMGET/RENAME in supported commands table
- [x] Added usage examples (multi-field hash ops, cross-type key rename) to protocols docs
- [x] Updated HTTP API reference with complete Redis command list (50+ commands)

## Phase 26: On-Chain Authentication, Aggregation Pipeline & SCRAM-SHA-256
- [x] **PlugPortAuth.sol** — standalone on-chain auth contract with EIP-712 meta-transactions, hash commitments (`keccak256(apiKey)`), SCRAM-SHA-256 verifiers, dedicated gas station, 10-key limit, nonce replay protection
- [x] **Aggregation pipeline** — full `$match`, `$project`, `$sort`, `$limit`, `$skip`, `$unwind`, `$count`, `$lookup` (cross-collection joins) in wire-server and HTTP API
- [x] **SCRAM-SHA-256** — wire protocol authentication via `saslStart`/`saslContinue` with on-chain verifier lookup + PLAIN fallback
- [x] **Transactions** — best-effort buffer-and-flush via `startTransaction`, `commitTransaction`, `abortTransaction`
- [x] **HTTP auth relay endpoints** — `POST /auth/register-key`, `POST /auth/revoke-key`, `GET /auth/keys/:address` (meta-tx relay via gas station)
- [x] **Dashboard**: API Keys tab rewrite (wallet-derived key generation, on-chain revocation, key recovery by re-signing indices 0–9)
- [x] **Dashboard**: Query Builder aggregate mode (find/aggregate toggle, pipeline editor, template presets for `$match+$sort`, `$lookup`, `$unwind+$count`, `$project`)
- [x] **SDKs**: `Collection.aggregate()` added to Node.js, Python, and Go SDKs
- [x] **CLI**: `plugport aggregate <collection> --pipeline '<json>'` command added
- [x] **Integration tests**: 11-case aggregate test suite (`$match`, `$project`, `$sort`, `$limit`, `$skip`, `$count`, `$unwind`, `$lookup`, combined pipelines)
- [x] **Docs**: Full authentication doc (`docs/advanced/authentication.md`), updated migration guide, wire protocol, FAQ, HTTP API, and all SDK docs
- [x] **README**: Updated features table, project structure, architecture diagram (PlugPortAuth.sol added)
- [x] **Deploy**: `.env.example`, `.env.testnet.example`, `.env.mainnet.example` updated with `AUTH_CONTRACT_ADDRESS` and `AUTH_GAS_STATION_PRIVATE_KEY`

## Phase 27: Live Contract Integration (AuthContractAdapter)
- [x] Created `auth/auth-contract.ts` — ethers.js v6 adapter for PlugPortAuth.sol (singleton, graceful fallback when not configured)
- [x] Wired `POST /auth/register-key` to `authContract.registerKeyMeta()` — returns `txHash` + `keyIndex`
- [x] Wired `POST /auth/revoke-key` to `authContract.revokeKeyMeta()` — returns `txHash`
- [x] Wired `GET /auth/keys/:address` to `authContract.getActiveKeys()` — returns on-chain key entries
- [x] Wired SCRAM-SHA-256 `saslStart` to read on-chain verifiers via `getVerifier(address, keyIndex)` with legacy fallback
- [x] Exported `AuthContractAdapter`, `getAuthContract`, `OnChainKeyEntry`, `ScramVerifier` from auth barrel

## Phase 28: 4th Audit Fixes (11/07/2026)
- [x] **S1**: `rotateKey` reordered to revoke-first-then-register for atomicity safety
- [x] **S2**: Added `rotateKeyMeta` meta-tx function + `ROTATE_TYPEHASH` constant
- [x] **B1**: SCRAM session TTL cleanup (60s max age, 30s interval, 1000 session cap with LRU eviction)
- [x] **B2**: Multi-key SCRAM lookup — `0xAddress:N` format or auto-select first active key
- [x] **B4**: Aggregation pipeline cap at 50 stages (error code 15942)
- [x] **S5**: Narrowed CSRF exemption to 4 session endpoints only
- [x] **I1**: Unsupported pipeline stages now log warnings
- [x] **I2**: `$lookup` warns when foreign collection > 10K docs
- [x] **I3**: Auth contract conditionally initialized (no-op when address empty)
- [x] **I4**: `getActiveKeys` uses `Promise.all` for batched RPC calls
- [x] **I5**: `RENAME` clears conflicting cross-type keys at destination
- [x] Audit report saved to `audits/12072026/audit_12072026.md`

## Phase 29: 4th Audit Downstream Gap Fixes (12/07/2026)
- [x] **Gap 1**: Added `rotateKeyMeta` to ABI + adapter method in `auth-contract.ts`
- [x] **Gap 1**: Added `POST /api/v1/auth/rotate-key` endpoint with gas station relay + fallback
- [x] **Gap 2**: Documented `rotateKeyMeta`, multi-key SCRAM format (`0xAddress:N`), and 50-stage pipeline limit in docs
- [x] **Gap 3**: Added `handleRotateOnChain()` + Rotate button in dashboard `ApiKeysTab.tsx`
- [x] **Gap 4**: Created `protocol-security.test.ts` (8 tests: B4 pipeline cap, I5 RENAME cross-type, B2 SCRAM parsing, rotate-key endpoint)
- [x] **Gap 4b**: Applied B4 pipeline cap (50 stages) to HTTP aggregate endpoint

## Phase 30: v4 genesis: multi-relayer, security upgrades, improved error handling, cli sync and production templates (13/07/2026)
- [x] `PlugPortAuth.sol` decentralized relayers + slot reuse
- [x] SSE heartbeat added for half-open TCP connections
- [x] AST depth/complexity and buffer limits added
- [x] `ApiKeysTab` network error toast handling improved
- [x] K8s, Docker, CI/CD and CLI production limits synced
- [x] k6 load test bombardment for `/verify` and `/sql`

## Phase 31: Fully Subsidized Gas Model (13/07/2026)
- [x] Upgraded to comma-separated `AUTH_GAS_STATION_PRIVATE_KEYS` array
- [x] Background balance polling for gas station wallets
- [x] Round-robin `getNextWriteContract()` router implementation
- [x] Added `GET /api/v1/deploy/system-gas-station` endpoint
- [x] Replaced dashboard Gas Station input with 'PlugPort Subsidized' badge
- [x] `useContractDeployer` hook automated querying system endpoint

## Phase 32: Final v4 Scope Docs & Testing Cleanups (13/07/2026)
- [x] Updated `architecture.md`, `private-store.md`, and `message-broker.md` to reflect PlugPort-subsidized gas stations
- [x] Updated `README.md` to clarify the subsidized gas model
- [x] Scaled `crud-mix.js` to 1500 concurrent users and blasted `/api/v1/auth/nonce` and `/api/v1/auth/verify`
- [x] Fixed legacy bug in `aggregate.test.ts` where it was hitting the deprecated `/insert` endpoint instead of `/insertMany`
- [x] Fixed `plugport init` to scaffold `.env` with `AUTH_CONTRACT_ADDRESS` and `AUTH_GAS_STATION_PRIVATE_KEYS`
- [x] Implemented `plugport deploy` to interactively scaffold Docker/K8s deployment templates

## Phase 33: SQL Server Security Hardening (17/07/2026)
- [x] Implemented missing 10,000 character limit on raw SQL query strings in `sql-translator.ts`
- [x] Implemented missing statement timeout limit in `pg-server.ts` and `mysql-server.ts`
- [x] Added `SQL_STATEMENT_TIMEOUT_MS` to server config and `.env.example`