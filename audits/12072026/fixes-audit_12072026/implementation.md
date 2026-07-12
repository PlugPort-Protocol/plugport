# 4th Audit Fixes — Implementation Plan

Fixes for all 13 findings from [audit_12072026.md](../audit_12072026.md), plus 4 downstream gaps identified during fix verification.

**Baseline commit:** `36b0308c9164aedcbffb072a73fc3afa1aad1eab`

## Proposed Changes

### S1 — `rotateKey` order-of-operations

#### [MODIFY] `contracts/PlugPortAuth.sol`
- Swap `_revokeKey` and `_registerKey` call order in `rotateKey()`. Revoke first so that if it fails, no orphan key is created — the entire transaction reverts cleanly.

### S2 — Missing `rotateKeyMeta` meta-transaction

#### [MODIFY] `contracts/PlugPortAuth.sol`
- Add `ROTATE_TYPEHASH` constant for EIP-712 typed data
- Add `rotateKeyMeta()` function with signature verification, `onlyGasStation` modifier, nonce increment, and revoke-first ordering (consistent with S1)

### S3 — Immutable `DOMAIN_SEPARATOR` (No change)

Testnet-only risk. Document as known limitation for mainnet deployment.

### B1 — `scramSessions` unbounded Map

#### [MODIFY] `packages/server/src/wire-server.ts`
- Add `createdAt: number` to `ScramState` interface
- Add `SCRAM_SESSION_TTL_MS = 60_000` and `MAX_SCRAM_SESSIONS = 1000` constants
- Add 30s `setInterval` cleanup (`.unref()` to avoid blocking process exit)
- Before inserting a new session, evict oldest when cap reached (LRU-style)

### B2 — On-chain verifier always uses keyIndex 0

#### [MODIFY] `packages/server/src/wire-server.ts`
- Parse `0xAddress:N` username format for specific key index
- When no index: call `getActiveKeys()` and use first active key's verifiers
- Preserve fallback to legacy `apiKey` derivation

### B4 — No pipeline stage count limit

#### [MODIFY] `packages/server/src/wire-server.ts`
- Add `MAX_PIPELINE_STAGES = 50` constant
- Return error `{ ok: 0, errmsg: '...', code: 15942 }` when exceeded

#### [MODIFY] `packages/server/src/http-server.ts`
- Apply same 50-stage pipeline cap to the HTTP aggregate endpoint (Gap 4b)

### S5 — CSRF exemption too broad

#### [MODIFY] `packages/dashboard/src/lib/api.ts`
- Add `AUTH_SESSION_ENDPOINTS` whitelist (nonce, verify, me, logout)
- Add `isAuthSessionEndpoint(path)` helper function
- Replace `!path.startsWith('/api/v1/auth/')` with `!isAuthSessionEndpoint(path)`
- `/auth/register-key`, `/auth/revoke-key`, and `/auth/rotate-key` now correctly include CSRF tokens

### I1 — Unsupported stages silently skipped

#### [MODIFY] `packages/server/src/wire-server.ts`
- Replace silent `break` with `console.warn(`[Wire] Unsupported aggregation stage: "${stageKey}" — skipped`)`

### I2 — `$lookup` loads all foreign docs

#### [MODIFY] `packages/server/src/wire-server.ts`
- Add `console.warn` when `foreignDocs.length > 10_000` suggesting filtering or indexing

### I3 — Read contract created with empty address

#### [MODIFY] `packages/server/src/auth/auth-contract.ts`
- Wrap contract creation in `if (this.contractAddress)` guard
- Change `readContract` type to `ethers.Contract | null = null`
- Update `isReadable` to check `!!this.readContract`
- Add `!` non-null assertions on 6 guarded usages

### I4 — N+1 RPC calls for `getActiveKeys`

#### [MODIFY] `packages/server/src/auth/auth-contract.ts`
- Replace sequential `for` loop with `Promise.all` + `map`
- Batch `getCommitment` + `getVerifier` per key with inner `Promise.all`

### I5 — `RENAME` doesn't clear conflicting type keys

#### [MODIFY] `packages/server/src/protocols/redis-server.ts`
- Before writing the renamed key, iterate all prefixes and `delete` any existing entries for the destination key name
- Wrap deletes in `try/catch` for already-missing keys

---

## Gap 1 — Missing `rotateKeyMeta` adapter + HTTP endpoint

#### [MODIFY] `packages/server/src/auth/auth-contract.ts`
- Add `rotateKeyMeta` to ABI string array
- Add `rotateKeyMeta()` adapter method (matches `registerKeyMeta`/`revokeKeyMeta` pattern)

#### [MODIFY] `packages/server/src/http-server.ts`
- Add `POST /api/v1/auth/rotate-key` endpoint with gas station meta-tx relay and log-only fallback

## Gap 2 — Undocumented behaviors in docs

#### [MODIFY] `docs/docs/advanced/authentication.md`
- Document `rotateKeyMeta` in the key lifecycle diagram and gas station section
- Document multi-key SCRAM username format (`0xAddress:N`)
- List all meta-tx variants (`registerKeyMeta`, `revokeKeyMeta`, `rotateKeyMeta`)

#### [MODIFY] `docs/docs/api-reference/wire-protocol.md`
- Add "Maximum 50 stages per pipeline" note to aggregate command

## Gap 3 — Dashboard missing on-chain rotation

#### [MODIFY] `packages/dashboard/src/app/components/ApiKeysTab.tsx`
- Add `handleRotateOnChain()` function (derives new key, signs EIP-712, calls `/auth/rotate-key`)
- Add Rotate button alongside Revoke button for active on-chain keys

## Gap 4 — Missing test coverage for audit fixes

#### [NEW] `packages/server/src/__tests__/protocol-security.test.ts`
- B4: Pipeline cap test (51 stages rejected, 50 stages allowed)
- I5: RENAME cross-type key cleanup (string overwrites hash, no conflict)
- B2: Multi-key SCRAM username format parsing (`0xAddr:N`, plain `0xAddr`, edge cases)
- `POST /auth/rotate-key`: Validation (400) and fallback mode (200)

---

## Verification Plan

### Automated Tests
- `cd packages/server && npx vitest run` — 216 unit tests (208 original + 8 new)
- `cd packages/dashboard && npx vitest run` — 18 CSS tests
- `cd packages/server && npx tsc --noEmit` — type-check

### Manual Verification
- Verify `rotateKey`/`rotateKeyMeta` ordering by reading contract source
- Verify SCRAM session cleanup by inspecting constants and interval code
- Verify CSRF narrowing by reading `isAuthSessionEndpoint` helper
- Verify Rotate button appears in dashboard for active on-chain keys
