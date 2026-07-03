# Audit Fix Walkthrough: T3, R1–R3, N1–N6

## Summary

Fixed all remaining audit items from the 2nd round audit (`audit_02072026.md`): 1 testing gap (T3), 3 residual code quality issues (R1–R3), and 6 new security/quality findings (N1–N6). Total: **244 tests passing** (203 server + 18 dashboard CSS + 23 integration).

---

## T3 — Visual Regression Tests

### New Files
- `packages/dashboard/src/__tests__/css-tokens.test.ts` — 18 Vitest tests that parse `globals.css` and validate:
  - `:root` defines all layout tokens (`--sidebar-width`, `--header-height`, `--radius-*`, `--transition-*`, `--gradient-*`)
  - `[data-theme='dark']` only overrides color/shadow tokens (no layout re-definitions)
  - `.btn-primary` uses `var(--gradient-primary)` — no hardcoded backgrounds
  - `.btn-secondary` uses `var(--bg-card)` + `var(--text-primary)` — no hardcoded colors
  - Complete color system presence in `:root` (accent, bg, text tokens)
- `packages/dashboard/vitest.config.ts` — Minimal vitest config for dashboard

### Modified
- `packages/dashboard/package.json` — Added `vitest` devDep, `test` and `test:visual` scripts

---

## R1 — Silent Catches in `monaddb-adapter.ts`

### `packages/server/src/storage/monaddb-adapter.ts`
- **L111**: `catch {}` → `catch (err) { console.warn('[MonadAdapter] Failed to load key index...') }`
- **L202**: `catch { return 0; }` → `catch (err) { console.warn('[MonadAdapter] keyCount() RPC failed...'); return 0; }`

Still returns fallback values but now logs warnings for observability.

---

## R2 — Analytics Fire-and-Forget

### `packages/server/src/http-server.ts`
- **L175**: `.catch(() => {})` → `.catch((err) => { if (LOG_LEVEL === 'debug') console.warn(...) })`

Gated behind `LOG_LEVEL=debug` to avoid noise in production, but enables debugging when needed.

---

## R3 — Routing Adapter Silent Catch

### `packages/server/src/storage/routing-adapter.ts`
- **L140**: `catch { /* ignore */ }` → `catch (err) { console.warn('[RoutingAdapter] Failed to clear private adapter...') }`

---

## N1 — `GET /collections/:name/roles` Auth

### `packages/server/src/http-server.ts`
- Added `if (!req.user?.address)` → 401
- Added ownership check: `privacy.ownerAddress !== req.user.address` → 403
- Only the collection owner can view the full ACL

### Tests Updated
- `packages/server/src/__tests__/access-control.test.ts` — 2 new tests (401 without auth, 403 for non-owner)
- `tests/integration/src/integration.test.ts` — `GET /roles` calls now pass `x-test-wallet-address: 0xTestOwner`

---

## N2 — Privacy Endpoint Info Reduction

### `packages/server/src/http-server.ts`
- Owner sees full privacy object (mode, ownerAddress, accessRoles, contractAddress, timestamps)
- Non-owner/unauthenticated sees only `{ mode, ownerAddress }` — no ACL or contract info leaked

---

## N3 — `POST /whitelist` Auth

### `packages/server/src/http-server.ts`
- Added `if (!req.user?.address)` → 401 to `POST /api/v1/whitelist`

### Tests Updated
- `packages/server/src/__tests__/access-control.test.ts` — 1 new test (401 without auth)
- `packages/server/src/__tests__/protocol-integration.test.ts` — All `POST /whitelist` calls now include `x-test-wallet-address: 0xAdminUser`

---

## N4 — Roles POST Error Handling

### `packages/server/src/http-server.ts`
- Added explicit privacy check before `grantAccess()`/`revokeAccess()`:
  - No privacy settings → 404 with `"Set privacy mode first"` message
  - Not the owner → 403 with `"Only the collection owner can modify access roles"`
- Eliminated the raw error message leak from delegated ownership validation

---

## N5 — Integration Test Cleanup

### `tests/integration/src/integration.test.ts`
- `afterAll` drop call now passes `x-test-wallet-address: 0xTestOwner` header
- Collection cleanup no longer silently fails with 403 after privacy mode is set

---

## N6 — Balance Precision

### `packages/server/src/http-server.ts`
Before:
```typescript
const balanceEth = Number(balanceWei * 1000000n / (10n ** 18n)) / 1000000;
```
After:
```typescript
const wholePart = balanceWei / (10n ** 18n);
const fracPart = (balanceWei % (10n ** 18n)).toString().padStart(18, '0').slice(0, 6);
const balanceStr = `${wholePart}.${fracPart}`;
```

Also changed `isLow` from `balanceEth < 0.1` (float comparison) to `balanceWei < 10n ** 17n` (pure BigInt comparison).

---

## Test Results

| Suite | Tests | Status |
|-------|-------|--------|
| Server unit tests | 203 | ✅ All passing |
| Dashboard CSS tests | 18 | ✅ All passing |
| Integration tests | 23 | ✅ All passing |
| **Total** | **244** | **✅** |
