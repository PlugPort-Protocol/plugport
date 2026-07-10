# Walkthrough: Auth Rate Limiting + CSRF Protection

## Summary

Implemented both "Areas for Future Improvement" from the 2nd audit report: stricter per-route rate limiting on auth endpoints and double-submit CSRF token protection for session-authenticated mutations. **249 tests passing** (208 server + 18 dashboard + 23 integration).

---

## 1. Auth Rate Limiting

### `packages/server/src/http-server.ts`

Added route-level `config.rateLimit` overrides using `@fastify/rate-limit` (no new dependencies):

| Endpoint | Global Limit | **New Per-Route Limit** |
|----------|-------------|------------------------|
| `POST /auth/nonce` | 100/10s | **10/min** |
| `POST /auth/verify` | 100/10s | **5/min** |
| `GET /auth/me` | 100/10s | **30/min** |
| `POST /auth/logout` | 100/10s | **10/min** |

The per-route limit takes precedence over the global limit for these endpoints. All other endpoints retain the global 100/10s cap.

---

## 2. CSRF Protection (Double-Submit Cookie)

### How It Works

1. **On `/auth/verify` success:** Server generates `randomBytes(32).toString('hex')`, stores it in the encrypted `iron-session` cookie AND sets a separate non-httpOnly `plugport_csrf` cookie.
2. **On mutations (POST/PUT/DELETE):** The `onRequest` middleware validates `x-csrf-token` header matches `session.csrfToken` for cookie-authenticated (SIWE) users.
3. **On `/auth/logout`:** Both session and CSRF cookies are cleared.

### Exemptions

| Auth Method | CSRF Required? | Why |
|------------|---------------|-----|
| Session cookie (SIWE) | ✅ Yes | Cookie-based = vulnerable to CSRF |
| API key (`pp_live_*`, `x-api-key`) | ❌ No | Header-only auth, no cookies |
| Test backdoor (`x-test-wallet-address`) | ❌ No | Dev-only, non-production |
| No auth (dev mode) | ❌ No | No session to protect |

### Files Changed

#### `packages/server/src/auth/session.ts`
- Added `csrfToken?: string` to `SessionData` interface

#### `packages/server/src/http-server.ts`
- Added `randomBytes` import from `crypto`
- CSRF validation in `onRequest` middleware (after session auth, before route handler)
- CSRF token generation in `/auth/verify` + `plugport_csrf` cookie set
- CSRF cookie cleared in `/auth/logout`
- Rate limit configs on all 4 auth endpoints

#### `packages/dashboard/src/lib/api.ts`
- Added `getCsrfToken()` helper that reads the `plugport_csrf` cookie from `document.cookie`
- `apiPost()` — attaches `x-csrf-token` header (exempts `/api/v1/auth/*` paths since those are pre-auth)
- `apiPut()` — attaches `x-csrf-token` header
- `apiDelete()` — attaches `x-csrf-token` header

---

## 3. Tests Added

### `packages/server/src/__tests__/auth-security.test.ts` (5 tests)

| # | Test | Validates |
|---|------|-----------|
| 1 | 11th `/auth/nonce` in 1 min → 429 | Nonce rate limit (10/min) |
| 2 | 6th `/auth/verify` in 1 min → 429 | Verify rate limit (5/min) |
| 3 | POST with `x-test-wallet-address` → 200 | Test backdoor bypasses CSRF |
| 4 | POST with invalid `pp_test_*` key → 401 | API key auth returns 401, not 403 CSRF |
| 5 | GET `/health` → 200 | GET requests exempt from CSRF |

---

## 4. Test Results

| Suite | Tests | Status |
|-------|-------|--------|
| Server unit tests | 208 | ✅ All passing |
| Dashboard CSS tests | 18 | ✅ All passing |
| Integration tests | 23 | ✅ All passing |
| **Total** | **249** | **✅** |
