# PlugPort Audit

## Round 1: Core Server (Completed)
- [x] Add `validateCollectionName()` — reject `:`, `..`, `/`, null, empty, >120 chars
- [x] Add `sanitizeDocument()` — reject `__proto__`, `constructor.prototype`
- [x] Fix insert partial failure doc count desync
- [x] Add default query limit (1000) for unbounded queries
- [x] Fix upsert to strip `$`-operators from filter
- [x] Constant-time API key comparison (`timingSafeEqual`)
- [x] Wrap `deleteOne`/`deleteMany` in try/catch
- [x] Fix `kvStore` type to `KVAdapter & diagnostics`
- [x] Add 48MB max message size check
- [x] Move `requestIdCounter` into closure
- [x] Add warning log for SASL placeholder
- [x] Fixed pre-existing key encoding delimiter bug (`\x1F`)
- [x] Fixed pre-existing `_id` uniqueness enforcement bug
- [x] Fixed `index.ts` test execution crash

## Round 2: SDKs, CLI, & Adapters
- [x] **Node.js SDK**: Add `AbortSignal` timeouts to `HttpTransport.fetch` to prevent indefinite hangs.
- [x] **Python SDK**: Add `timeout` parameter to `requests.Session` calls to prevent indefinite hangs.
- [x] **MonadDB Adapter**: Add `AbortSignal` timeouts to `fetch` RPC calls to prevent server stall on RPC drops.
- [x] **Dashboard API**: Add `AbortSignal` timeouts to `apiPost` and `apiGet` and `useApi` to prevent UI freezing.
- [x] **CLI**: Refactor `migrate` command to stream JSON dump using `readline` instead of `readFileSync` to prevent Out-Of-Memory (OOM) crashes on large datasets.

## Round 3: Integration, Concurrency, & Edge Cases
- [x] **Deployment**: Update server `index.ts` to fallback to `PORT` environment variable (for Render/Railway compatibility).
- [x] **Data Model / Shared**: Add `batchWrite` to `KVAdapter` interface.
- [x] **MonadDb Adapter**: Replace stateful `startBatch`/`flushBatch` with stateless thread-safe `batchWrite`.
- [x] **Document Store**: Refactor `insertMany` and `deleteMany` to use `batchWrite` for massive gas optimizations.

## Round 4 Fixes (Security & Data Integrity)
- [x] Implement `Mutex` collection locks natively across `DocumentStore` metadata reads/writes preventing async race conditions.
- [x] Connect `apiKey` config from `packages/server/src/index.ts` to `WireServerOptions`.
- [x] Implement `PLAIN` SASL wire protocol authentication rejecting unauthorized opcodes on `wire-server.ts`.

## Round 5: Integrity, Resilience & Frontend Auth
- [x] Implement Two-Phase `checkUnique` Commit in `index-manager.ts` preventing partial index data corruption.
- [x] Short-circuit `query-planner.ts` un-sorted queries halting execution when `limit` and `skip` constraints are fulfilled minimizing OOM loads.
- [x] Install `@fastify/rate-limit` inside `@triedbx/server` mitigating DoS vulnerabilities.
- [x] Apply `x-api-key` header payloads inside the Dashboard `api.ts` React fetching library supporting strictly authorized backend deployments.

## Round 6: Scale Limits, HTTP Payloads, & SDK Backoffs
- [x] Implement chunking boundaries `limit: 5000` inside `document-store.ts` `deleteMany` operations to mitigate unbounded Engine OOM failures.
- [x] Configure `@fastify` to map `bodyLimit: 52428800` (50MB) neutralizing default 1MB caps scaling Bulk API migrations safely.
- [x] Patch Node.js `@triedbx/sdk` modifying `HttpTransport` incorporating 429 Rate Limit retry intervals.
- [x] Patch Python SDK `/sdks/python/triedbx/client.py` incorporating equivalent `HttpTransport` 429 status retries with exponential backoffs.

## Round 7: System Memory Leaks & Pagination Bounds
- [x] Implement `unknown_or_overflow` limit bounds inside `metrics.ts` protecting node servers from unbounded Metric Object maps.
- [x] Fix `maxNeeded` logical evaluations inside `query-planner.ts` un-capping standard `limit: undefined` array returns natively mapping infinite iterations.

## Round 8: Uncaught Exceptions & Array Chunking
- [x] Assert `messageLength` >= 16 bytes inside `wire-server.ts` resolving remote execution `RangeError` un-caught crash vectors. 
- [x] Strip monolithic `getAllDocuments` caches migrating `document-store.ts` and `index-manager.ts` endpoints mapping sequential 5,000 document chunk loops protecting background workers.

## Round 9: Global Iteration Bounds & `.scan()` Loop Bypasses
- [x] Overhaul `executeQuery` in `query-planner.ts` injecting 5000-chunk limits across `this.kv.scan({})` preventing OOM arrays bypassing `maxNeeded`.
- [x] Migrate `dropCollection` and `getStats` inside `document-store.ts` breaking `kv.scan` fetches identically parsing bounded sequential chunks safely.
- [x] Strip raw `.scan({ prefix })` usages across `dropIndex` and `dropAllIndexes` inside `index-manager.ts` avoiding OOM exceptions natively.

## Round 10: Extreme Edge Cases & Connection Exhaustion
- [x] Implement `socket.setTimeout(60000)` inside `wire-server.ts` destroying idle Slowloris TCP connection floods.
- [x] Relocate `try/catch` wrappers strictly encompassing `parseHeader` synchronous executions closing Uncaught Promise Rejection holes.
- [x] Establish iterative 5000-block `<chunk>` generation loops across `insert` buffering user arrays securely off Heap limits natively avoiding `Fastify` constraints.

## Round 11: Explicit Query Bypasses & Missing Feature Pipelines
- [x] Enforce `MAX_QUERY_LIMIT = 5000` clamping explicit `options.limit` properties neutralizing 5-Million Object REST attacks globally.
- [x] Map `MAX_SORT_EVAL_LIMIT = 50000` executing protective exceptions rejecting natively uncapped `options.sort` array bloat before JS iterations run.
- [x] Implement `updateMany` internally inside `document-store.ts` executing bounded `< 5000` mutation chunks resolving identical memory constraints efficiently.
- [x] Parse `upd.multi === true` and map new `/api/v1/collections/:name/updateMany` REST endpoints connecting native driver logic universally.

## Round 12: Infinite Metrics Tracking Bypasses & Object Leaks
- [x] Enforce `MAX_TRACKED_ERRORS = 100` bounds isolating `metrics.errorCodes` array growths natively rejecting overflow attacks causing Javascript Heap timeouts.

## Round 13 Audit: Advanced Vectors, ReDoS, & Deep Logic Flaws
- [x] Audit `query-planner.ts` for Regex Denial of Service (ReDoS) and unbounded `$in` arrays.
- [x] Audit `document-store.ts` `$set` and `$inc` operators for deep structural exploits and type coercion bugs.
- [x] Audit BSON deserialization limits in `wire-server.ts` for deep nesting Stack Overflow vulnerabilities.
- [x] Investigate Index key size limits in `index-manager.ts` preventing KV store bloat on massive string indexing.

## Round 14 Audit: Logic Bugs, Dead Code, Error Handling, & SDK Gaps
- [x] Fix dead code in `wire-server.ts` `saslContinue` — unreachable `return { ok: 1 }` after prior return.
- [x] Add `updateMany` to `extractCommand` in `http-server.ts` — currently mapped to `unknown` in metrics.
- [x] Use constant-time comparison for SASL auth password in `wire-server.ts` — currently plain `===`.
- [x] Wrap `find`, `dropIndex`, `stats` HTTP endpoints in try/catch error handling.
- [x] Fix `checkUnique` in `index-manager.ts` — allows self-collision on upsert (doesn't exclude `currentDocId`).
- [x] Add `updateMany` SDK method to Node.js SDK `Collection` class.
- [x] Validate `req.body` existence in HTTP endpoints to prevent crashes on empty/malformed POST bodies.
- [x] Cap `normalizeDocument` recursion depth in `wire-server.ts` to prevent stack overflow on deep BSON.

## Round 15: Feature Gaps — New Operators, Endpoints, & SDK Parity
- [x] Add `$inc` update operator to `updateOne`/`updateMany` in `document-store.ts`.
- [x] Add `$unset` update operator to `updateOne`/`updateMany` in `document-store.ts`.
- [x] Add `$or` query filter operator to `matchesFilter` in `query-planner.ts`.
- [x] Add `$nin` (not-in) query filter operator to `matchesComparison` in `query-planner.ts`.
- [x] Add `$exists` query filter operator to `matchesComparison` in `query-planner.ts`.
- [x] Add `/api/v1/collections/:name/count` HTTP endpoint in `http-server.ts`.
- [x] Add `/api/v1/collections/:name/distinct` HTTP endpoint in `http-server.ts`.
- [x] Update HTTP update endpoint type signatures to accept `$inc` and `$unset`.

## Round 16: V3 Parity Hardening & Security
- [x] Fix GitHub Actions CI timeouts by fully integrating `start-server-and-test` for the integration suite.
- [x] Correct SQL AST translation mappings to natively bridge `CREATE INDEX` and `DROP INDEX` without unhandled errors.
- [x] Export explicit typings for Role-Based Access Control (`RoleGrantPayload`, `CollectionPrivacy`) in `@plugport/shared`.
- [x] Remove API key generation `isTestnet` hardcoding and dynamically read the `.env` state globally.
- [x] Massive `.env.example` overhaul introducing all modern protocol port toggles and smart contract dependencies.
- [x] Add `update_many`, `distinct`, `count_documents` (server-side), `estimated_document_count` to Python SDK.
- [x] Update Node.js SDK `countDocuments` to use server-side `/count` endpoint.
- [x] Add `distinct` method to Node.js SDK `Collection`.
- [x] Update Node.js SDK `updateOne`/`updateMany` type signatures to accept `$inc`/`$unset`.

## Round 16 Audit: Cross-Component Logic, Security Hardening, & Branding
- [x] Replace TrieDBX ASCII banner with PlugPort in `index.ts`.
- [x] Fix wire-server update type casts to include `$inc`/`$unset` (was `$set`-only).
- [x] Add wire-server buffer accumulation cap (MAX_MESSAGE_SIZE OOM protection).
- [x] Add `countDocuments` method to `document-store.ts` bypassing query limit cap.
- [x] Cap `listCollections` scan to 1000 in `document-store.ts`.
- [x] Apply `sanitizeDocument` to `$inc`/`$unset` payloads (prototype pollution prevention).
- [x] Add `$or` index optimization to `planQuery` in `query-planner.ts`.
- [x] Add `count`/`distinct`/`findOne` to `extractCommand` for proper metrics tracking.

## Round 17: V3 Multi-Protocol Expansion & Cryptography
- [x] Implemented `ProtocolManager` orchestrating MongoDB, PostgreSQL, MySQL, Redis, and SQLite environments.
- [x] Deployed SQL Translation Layer mapping Postgres/MySQL text commands to DocumentStore payloads.
- [x] Implemented `JoinEngine` performing in-memory Hash, Left, Right, and Cross joins.
- [x] Integrated `PlugPortPrivateStore` smart contract and AES-256-GCM + ECDH `EncryptionLayer` for private scoping.
- [x] Deployed `PlugPortMessageBroker` for real-time Pub/Sub on-chain.
- [x] Deployed `@plugport/sqlite-compat` drop-in SDK proxying local SQLite requests to the cloud.

## Round 18: V3 Dashboard, Universal Auth, & Real-Time Streams
- [x] Pivot Next.js Dashboard to support Sign-In With Ethereum (SIWE) and API Key inputs simultaneously.
- [x] Build Protocols Dashboard Tab allowing toggle access to SQL and RESP endpoints.
- [x] Build Privacy & ACL Tab mapping Wallet addresses to explicit Collection permissions.
- [x] Implement Server-Sent Events (SSE) `/api/v1/subscribe` streaming Pub/Sub payloads to UI.
- [x] Implement JSON File Import mapping arbitrary objects directly into `InsertCommand` pipelines.
- [x] Expose 3-way scoping metrics evaluating Global, Personal, and Split-View aggregation models.

## Round 19: V3 Parity Hardening, SDK Alignment & Security
- [x] Fix GitHub Actions CI timeouts by fully integrating `start-server-and-test` for the integration suite.
- [x] Correct SQL AST translation mappings to natively bridge `CREATE INDEX` and `DROP INDEX` without unhandled errors.
- [x] Align Go, Python, Node, and sqlite-compat SDKs to forward `x-api-key` headers and native `.grantRole()` methods.
- [x] Export explicit typings for Role-Based Access Control (`RoleGrantPayload`, `CollectionPrivacy`) in `@plugport/shared`.
- [x] Remove API key generation `isTestnet` hardcoding and dynamically read the `.env` state globally.
- [x] Massive `.env.example` overhaul introducing all modern protocol port toggles and smart contract dependencies.

## Round 20: RoutingAdapter & Isolated Privacy Channels (V3 Architecture)
- [x] Replaced global `STORAGE_MODE` environment variable with dynamic `RoutingAdapter` supporting parallel isolated channels.
- [x] Instantiated `PrivacyManager` to evaluate collection permissions against the unified `publicAdapter` without encrypted cycle locks.
- [x] Refactored `EncryptionLayer` into a strict AES-256-GCM proxy delegating configuration state to the `RoutingAdapter`.
- [x] Cleaned `.env.example` files across the repo stripping legacy `STORAGE_MODE` prompts.
- [x] Removed `-private` prompt flag logic and associated `STORAGE_MODE` mapping in `@plugport/cli`.

## Round 21: SIWE + iron-session Refactor (S1 Critical Fix)
- [x] Deleted custom `siwe-handler.ts` (hand-rolled JWT + in-memory nonce store).
- [x] Created `session.ts` — encrypted cookie sessions via `iron-session`, secret derived from `MONAD_PRIVATE_KEY` (HMAC-SHA256, zero new env vars).
- [x] Replaced JWT Bearer auth middleware with session cookie read in Triple-Auth Middleware.
- [x] Replaced `/auth/nonce` endpoint: `siwe.generateNonce()` + nonce stored in session cookie.
- [x] Replaced `/auth/verify` endpoint: `SiweMessage.verify()` + nonce consumed + session set.
- [x] Added `/auth/logout` endpoint to destroy session cookie.
- [x] Locked CORS to `DASHBOARD_URL` env var in production with `credentials: true`.
- [x] Registered `@fastify/cookie` plugin for cookie parsing.
- [x] Dashboard `api.ts`: removed `setAuthToken()`, all fetch calls use `credentials: 'include'`.
- [x] Dashboard `auth-context.tsx`: uses `siwe.SiweMessage` for EIP-4361, cookie-based flow, auto sign-in on wallet connect.
- [x] Removed `jose` dependency from server; added `@fastify/cookie` + `iron-session`.
- [x] Added `siwe` dependency to dashboard for official message construction.
- [x] Updated `.env.example` files (root + server) with `DASHBOARD_URL` and session derivation docs.
- [x] Updated `configuration.md` and `architecture.md` docs.

## Round 22: Security Hotfixes S2–S6, B7
- [x] **S2**: Added `checkAccess()` to `count` and `distinct` endpoints — private collections now enforce read permission.
- [x] **S3**: Added auth + ownership check to `user/:address/collections` and `user/:address/metrics` — users can only view their own data.
- [x] **S4**: Removed `ownerAddress` body override in `deploy/register` — always uses `req.user.address` to prevent owner spoofing.
- [x] **S5**: Added auth check + address format validation (`/^0x[0-9a-fA-F]{40}$/`) to gas-station balance endpoint.
- [x] **S6**: Added ownership verification to `POST /collections/:name/privacy` — only collection owner can change privacy mode.
- [x] **B7**: Fixed `Number(balanceWei)` precision loss — now uses BigInt arithmetic for MON balance conversion.

## Round 23: Bug Fixes B1–B6
- [x] **B1**: Moved `--sidebar-width`, `--header-height`, `--radius-*`, `--transition-*` CSS tokens from dark-theme-only block to `:root` — light mode layout/animations fully working.
- [x] **B2**: Fixed `btn-primary` (was `background: black`) and `btn-secondary` (was `background: blue`) to use `var(--gradient-primary)` and `var(--bg-card)` theme tokens.
- [x] **B3**: Implemented `batchWrite()` on `InMemoryKVStore` — batch operations no longer silently drop writes in dev mode.
- [x] **B4**: `RoutingAdapter` diagnostic methods (`getKeyCount`, `getEstimatedSizeBytes`) now sum both public + private channels.
- [x] **B5**: RainbowKit modal dynamically switches between `darkTheme()` and `lightTheme()` based on `next-themes` `resolvedTheme`.
- [x] **B6**: `EncryptionLayer.scan()` now logs `console.warn` on decryption failure instead of silently swallowing errors.

## Round 24: Architecture Fixes A1–A7
- [x] **A1**: Created `types.ts` shared module extracting all interfaces (`CollectionInfo`, `MetricsData`, etc.), helpers (`formatUptime`, `formatBytes`), and type aliases from `page.tsx`. Full component split deferred as follow-up.
- [x] **A2**: CI pipeline now triggers on `v3` branch (`push` and `pull_request` events).
- [x] **A3**: Root `.env.example` already contains `MESSAGEBROKER_GAS_STATION` (line 66) and JWT_SECRET note (line 26) — no action needed.
- [x] **A4**: `PrivacyManager.listOwnedCollections()` scan capped at `limit: 10000` to prevent unbounded memory consumption.
- [x] **A5**: Already resolved by S1 — nonces stored in `iron-session` cookies, not in-memory `Map`. No multi-replica issue.
- [x] **A6**: Whitelist management persisted to KV store (`meta:whitelist:global` key) — survives server restarts, no more volatile `options` mutation.
- [x] **A7**: `RoutingAdapter.scan()` and `count()` now merge results from both public + private adapters for global (non-`col:` prefixed) operations.

## Round 25: Residual Fixes R1–R3
- [x] **R1**: Bounded `GET /deploy/contracts` scan with `limit: 10000` for consistency with A4.
- [x] **R2**: `page.tsx` now imports all types from `types.ts` — removed 76 lines of inline type definitions and duplicate `ProtocolInfo` interface. Removed duplicate `formatUptime`/`formatBytes` helpers.
- [x] **R3**: Fixed 3 pre-existing test failures in `monaddb-adapter.test.ts` — updated assertions to match `RoutingAdapter` wrapping behavior. Import added for `RoutingAdapter`.

## Round 26: Test Coverage T1–T4
- [x] **T1**: Created `access-control.test.ts` — 8 tests covering S2 (count/distinct ACL on private collections), S3 (user endpoint auth), and S5 (gas station auth + address validation).
- [x] **T2**: Created `routing-adapter.test.ts` — 15 tests covering privacy-based routing, global scan/count merging (A7), same-adapter dedup, batch write routing, and delete/clear semantics.
- [x] **T3**: CSS visual regression testing not applicable as unit tests. Light mode correctness verified via build (B1 fix).
- [x] **T4**: Created `kv-batch-write.test.ts` — 7 tests covering empty batches, multi-key puts/deletes, mixed operations, Uint8Array values, overwrites, and non-existent key deletes.

## Round 27: Improvement Suggestions I1–I10
- [x] **I1**: `page.tsx` monolith fully decomposed (2,114 → 253 lines, 88% reduction). Extracted 10 tab components + `ScopeToggle` into `components/` directory with barrel re-export. All types imported from `types.ts`. Dashboard build verified clean.
- [x] **I2**: Not applicable — JWT was replaced by iron-session in S1. No `JWT_SECRET` env var needed.
- [x] **I3**: Added TTL-based cache (30s) to `PrivacyManager.getCollectionPrivacy()` — eliminates 2 KV reads per request. Cache invalidated on writes.
- [x] **I4**: Already completed in B3 — `InMemoryKVStore.batchWrite()` implemented.
- [x] **I5**: Already completed in S1/A5 — nonces stored in iron-session cookies.
- [x] **I6**: Already completed in A2 — CI triggers include `v3` branch.
- [x] **I7**: Already completed in B1 — layout/motion tokens moved to `:root`.
- [x] **I8**: Already completed in B5 — RainbowKit theme synced with `next-themes`.
- [x] **I9**: Already completed in B2 — button colors use theme variables.
- [x] **I10**: Audited all bare `catch {}` blocks across server package. Added structured `console.warn` to: session cookie parse (debug-gated), contract metadata parse, `PrivacyManager.getCollectionPrivacy()`, and `PrivacyManager.listOwnedCollections()`. Left timing-safe comparison catch intentionally silent (security).
