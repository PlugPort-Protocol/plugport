# audit_17062026 — Checklist

## S1: SIWE Refactor
- [x] Install server deps (`@fastify/cookie`, `iron-session`; remove `jose`)
- [x] Create `packages/server/src/auth/session.ts`
- [x] Delete `packages/server/src/auth/siwe-handler.ts`
- [x] Update `packages/server/src/auth/index.ts`
- [x] Update `packages/server/src/http-server.ts` (middleware, endpoints, CORS)
- [x] Install dashboard dep (`siwe`)
- [x] Update `packages/dashboard/src/lib/api.ts`
- [x] Update `packages/dashboard/src/lib/auth-context.tsx`
- [x] Update `packages/dashboard/src/app/page.tsx`
- [x] Update `.env.example` files + docs

## S2–S6, B7: Security Hotfixes
- [x] **S2**: Add `checkAccess()` to `count` and `distinct` endpoints
- [x] **S3**: Guard `user/:address/*` with auth + ownership check
- [x] **S4**: Remove `ownerAddress` body override in `deploy/register`
- [x] **S5**: Add auth + address validation to gas-station balance endpoint
- [x] **S6**: Add ownership check for privacy mode changes
- [x] **B7**: Fix BigInt precision loss in MON balance conversion

## B1–B6: Bug Fixes
- [x] **B1**: Light mode CSS tokens moved to `:root`
- [x] **B2**: Button colors use theme variables
- [x] **B3**: `InMemoryKVStore.batchWrite()` implemented
- [x] **B4**: `RoutingAdapter` diagnostic sums both channels
- [x] **B5**: RainbowKit theme synced with `next-themes`
- [x] **B6**: `EncryptionLayer.scan()` warns on decryption failure

## A1–A7: Architecture
- [x] **A1**: Shared `types.ts` + full component extraction
- [x] **A2**: CI triggers include `v3` branch
- [x] **A3**: `.env.example` already complete
- [x] **A4**: `PrivacyManager.listOwnedCollections` scan capped
- [x] **A5**: Resolved by S1 (iron-session cookies)
- [x] **A6**: Whitelist persisted to KV store
- [x] **A7**: `RoutingAdapter` scan/count merges both adapters

## R1–R3: Residual Fixes
- [x] **R1**: Deploy contracts scan bounded
- [x] **R2**: Dashboard inline types removed
- [x] **R3**: Test assertions fixed for RoutingAdapter wrapping

## T1–T4: Test Coverage
- [x] **T1**: Access control integration tests (8 tests)
- [x] **T2**: RoutingAdapter routing tests (15 tests + 1 edge case)
- [x] **T3**: CSS correctness via build
- [x] **T4**: KV batchWrite tests (7 tests)

## I1–I10: Improvements
- [x] **I1**: `page.tsx` monolith fully decomposed (2,114→253 lines, 88% reduction). 10 tab components + `ScopeToggle` extracted to `components/` with barrel re-export
- [x] **I2**: N/A — JWT replaced by iron-session
- [x] **I3**: PrivacyManager TTL cache (30s)
- [x] **I4**: Already completed in B3
- [x] **I5**: Already completed in S1/A5
- [x] **I6**: Already completed in A2
- [x] **I7**: Already completed in B1
- [x] **I8**: Already completed in B5
- [x] **I9**: Already completed in B2
- [x] **I10**: Structured `console.warn` added to silent catch blocks

## Verify
- [x] Server: 200 tests passing (9 test files)
- [x] Dashboard: Build succeeds (Next.js production build)

## Project Tracking
- [x] Update `audit-log.md` (Rounds 21–27)
- [x] Update `checklist.md` (Phases 16–22)
