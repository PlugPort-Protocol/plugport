# Audit Fix Tasks — T3, R1–R3, N1–N6

## Server Fixes
- [x] R1: Add `console.warn` to `monaddb-adapter.ts` silent catches (L111, L202)
- [x] R2: Add debug logging to `http-server.ts` analytics fire-and-forget (L175)
- [x] R3: Add `console.warn` to `routing-adapter.ts` clear catch (L140)
- [x] N1: Add auth + ownership check to `GET /collections/:name/roles`
- [x] N2: Reduce `GET /collections/:name/privacy` payload for non-owners
- [x] N3: Add auth check to `POST /api/v1/whitelist`
- [x] N4: Add try/catch + 404/403 handling to `POST /collections/:name/roles`
- [x] N6: Use pure BigInt string arithmetic for balance formatting

## Dashboard
- [x] T3: Add vitest config + 18 CSS token validation tests

## Integration Tests
- [x] N5: Fix `afterAll` cleanup + update role test auth headers

## Test Updates (for new auth requirements)
- [x] Add N1/N3 tests to `access-control.test.ts` (3 new tests)
- [x] Update `protocol-integration.test.ts` whitelist tests with auth headers

## Verification
- [x] Run server unit tests: **203 passed** ✅
- [x] Run dashboard CSS tests: **18 passed** ✅
- [x] Run integration tests: **23 passed** ✅
