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
- [x] All 200 tests passing across 9 test files; dashboard build verified clean
