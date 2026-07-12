# Audit Fix Walkthrough: S1–S5, B1–B4, I1–I5, Gaps 1–4

## Summary

Fixed all 13 findings from the 4th audit (`audit_12072026.md`) plus 4 downstream gaps identified during fix verification. Total: **234 tests passing** (216 server + 18 dashboard CSS). Type-check clean.

---

## S1 — `rotateKey` Order-of-Operations

### `contracts/PlugPortAuth.sol`
- **L172–174**: Swapped `_registerKey` and `_revokeKey` call order.
- Before: register new key, then revoke old — orphan key possible on partial failure.
- After: revoke old key first, then register new — if revoke fails, entire tx reverts cleanly.

---

## S2 — `rotateKeyMeta` Meta-Transaction

### `contracts/PlugPortAuth.sol`
- **L61–63**: Added `ROTATE_TYPEHASH` constant.
- **L270–305**: Added `rotateKeyMeta()` function — full EIP-712 signature verification, `onlyGasStation` modifier, nonce increment, revoke-first ordering.

---

## B1 — SCRAM Session TTL Cleanup

### `packages/server/src/wire-server.ts`
- **L34**: Added `createdAt: number` to `ScramState` interface.
- **L38–43**: Added constants: `SCRAM_SESSION_TTL_MS = 60_000`, `MAX_SCRAM_SESSIONS = 1000`, `MAX_PIPELINE_STAGES = 50`.
- **L46–53**: Added 30s `setInterval` cleanup (`.unref()`).
- **L466–477**: LRU eviction when cap reached.
- **L486**: Set `createdAt: Date.now()` on session creation.

---

## B2 — Multi-Key SCRAM Lookup

### `packages/server/src/wire-server.ts`
- **L413–446**: Enhanced SCRAM `saslStart` to support `0xAddress:N` username format:
  - Parses colon-separated key index from username.
  - When no index: calls `getActiveKeys()` and uses first active key.
  - Falls back to legacy `apiKey` derivation.

---

## B4 — Aggregation Pipeline Stage Cap

### `packages/server/src/wire-server.ts`
- **L806–812**: Added early return when `pipeline.length > MAX_PIPELINE_STAGES` (50) with error code 15942.

### `packages/server/src/http-server.ts`
- **L518–525**: Applied same 50-stage cap to the HTTP aggregate endpoint (found during gap analysis — originally only in wire server).

---

## S5 — Narrowed CSRF Exemption

### `packages/dashboard/src/lib/api.ts`
- **L56–58**: Added `AUTH_SESSION_ENDPOINTS` whitelist and `isAuthSessionEndpoint()` helper.
- `/auth/register-key`, `/auth/revoke-key`, and `/auth/rotate-key` now correctly include CSRF tokens.

---

## I1 — Unsupported Pipeline Stage Warning

### `packages/server/src/wire-server.ts`
- **L952–953**: `default` case now logs `console.warn` instead of silently skipping.

---

## I2 — `$lookup` Large Collection Warning

### `packages/server/src/wire-server.ts`
- **L854–855**: Added warning when foreign collection exceeds 10K documents.

---

## I3 — Conditional Auth Contract Initialization

### `packages/server/src/auth/auth-contract.ts`
- **L72–83**: Wrapped contract creation in `if (this.contractAddress)` guard.
- **L61**: Changed `readContract` type to `ethers.Contract | null = null`.
- **L94–95**: Updated `isReadable` check.

---

## I4 — Batch RPC Calls in `getActiveKeys`

### `packages/server/src/auth/auth-contract.ts`
- **L186–202**: Replaced sequential loop with `Promise.all` + `map` for parallel RPC calls.

---

## I5 — RENAME Cross-Type Key Cleanup

### `packages/server/src/protocols/redis-server.ts`
- **L499–503**: Before writing the renamed key, clear all type-prefixed variants at the destination.

---

## Gap 1 — `rotateKeyMeta` Adapter + HTTP Endpoint

### `packages/server/src/auth/auth-contract.ts`
- **L21**: Added `rotateKeyMeta` to ABI array.
- **L172–217**: Added `rotateKeyMeta()` adapter method — calls contract, parses `KeyRotated` event for new index.

### `packages/server/src/http-server.ts`
- **L728–778**: Added `POST /api/v1/auth/rotate-key` endpoint. Uses gas station meta-tx relay when contract is configured, falls back to log-only mode otherwise.

---

## Gap 2 — Documentation Updates

### `docs/docs/advanced/authentication.md`
- Updated key lifecycle mermaid diagram: `revokeKey / revokeKeyMeta`, `rotateKey / rotateKeyMeta`.
- Added note that all key management operations have both direct and meta-tx variants.
- Updated gas station section to list all three meta-tx functions.
- Updated SCRAM section to document multi-key username format (`0xAddress:N`).

### `docs/docs/api-reference/wire-protocol.md`
- Added "Maximum 50 stages per pipeline" to aggregate command row.

---

## Gap 3 — Dashboard On-Chain Key Rotation

### `packages/dashboard/src/app/components/ApiKeysTab.tsx`
- **L220–273**: Added `handleRotateOnChain()` — derives new key, computes SCRAM verifiers, signs EIP-712 meta-tx, relays to `/auth/rotate-key`.
- **L476–491**: Added Rotate button alongside Revoke for active on-chain keys (flexbox layout with 8px gap).

---

## Gap 4 — Test Coverage for Audit Fixes

### `packages/server/src/__tests__/protocol-security.test.ts` (NEW — 8 tests)
- **B4**: Pipeline cap — 51 stages rejected (400, code 15942), 50 stages allowed (200).
- **I5**: RENAME cross-type cleanup — string overwrites hash, conflicting key cleared.
- **B2**: Multi-key SCRAM format — `0xAddr:N` parsed, plain `0xAddr` handled, edge cases.
- **rotate-key**: Validation (400 missing fields), fallback mode (200 log-only).

---

## Test Results

| Suite | Tests | Status |
|-------|-------|--------|
| Server unit tests | 216 | ✅ All passing |
| Dashboard CSS tests | 18 | ✅ All passing |
| Type-check (`tsc --noEmit`) | — | ✅ 0 errors |
| **Total** | **234** | **✅** |
