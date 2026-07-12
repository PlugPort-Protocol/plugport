# 4th Audit Fixes — Task Checklist

## Contract Changes
- [x] S1: Reorder `rotateKey` to revoke-first-then-register in `PlugPortAuth.sol`
- [x] S2: Add `ROTATE_TYPEHASH` constant + `rotateKeyMeta()` meta-tx function

## Server Changes
- [x] B1: Add SCRAM session TTL cleanup (60s max age, 30s interval, 1000 cap with LRU eviction)
- [x] B2: Support multi-key SCRAM lookup (`0xAddress:N` format or first active key)
- [x] B4: Cap aggregation pipeline at 50 stages in wire server (error code 15942)
- [x] B4: Cap aggregation pipeline at 50 stages in HTTP endpoint (same protection)
- [x] I1: Log `console.warn` on unsupported pipeline stages
- [x] I2: Log `console.warn` when `$lookup` foreign collection exceeds 10K docs
- [x] I3: Conditionally create auth contract instances only when address configured
- [x] I4: Batch `getActiveKeys` RPC calls with `Promise.all`
- [x] I5: Clear cross-type destination keys on `RENAME`

## Auth Adapter Changes
- [x] Gap 1: Add `rotateKeyMeta` to ABI + adapter method in `auth-contract.ts`
- [x] Gap 1: Add `POST /api/v1/auth/rotate-key` HTTP endpoint in `http-server.ts`

## Dashboard Changes
- [x] S5: Narrow CSRF exemption to 4 session endpoints (nonce, verify, me, logout)
- [x] Gap 3: Add `handleRotateOnChain()` function in `ApiKeysTab.tsx`
- [x] Gap 3: Add Rotate button for active on-chain keys

## Documentation Changes
- [x] Gap 2: Document `rotateKeyMeta` in key lifecycle diagram and gas station section
- [x] Gap 2: Document multi-key SCRAM username format (`0xAddress:N`) in auth docs
- [x] Gap 2: Add 50-stage pipeline limit note to wire-protocol.md

## Tests
- [x] Gap 4: B4 — pipeline cap test (51 rejected, 50 allowed)
- [x] Gap 4: I5 — RENAME cross-type cleanup test
- [x] Gap 4: B2 — multi-key SCRAM username format parsing tests (3 cases)
- [x] Gap 4: rotateKeyMeta HTTP endpoint tests (400 validation + 200 fallback)

## No Code Change Required
- [x] S3: Immutable `DOMAIN_SEPARATOR` — documented as testnet-only risk
- [x] S4: `getActiveKeys` loop bounded at 20 iterations — safe with MAX_KEYS = 10
- [x] B3: Salt truncation to 16 bytes — verified consistent between server and client

## Verification
- [x] Server type-check: `tsc --noEmit` — 0 errors ✅
- [x] Server unit tests: **216 passed** ✅
- [x] Dashboard CSS tests: **18 passed** ✅
- [x] Total: **234 tests** ✅
