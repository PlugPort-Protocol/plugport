# Implement Audit Improvement Suggestions

Two improvements from the 2nd audit report's "Areas for Future Improvement" section.

## 1. Stricter Rate Limiting on Auth Endpoints

**Problem:** The global rate limiter (100 req/10s per IP) applies uniformly. Auth endpoints (`/auth/nonce`, `/auth/verify`) should have much stricter limits to prevent nonce-flooding and brute-force signature verification.

### [MODIFY] `packages/server/src/http-server.ts`

Add per-route rate limit overrides on the four auth endpoints using `@fastify/rate-limit`'s route-level `config`:

| Endpoint | Limit | Rationale |
|----------|-------|-----------|
| `POST /auth/nonce` | 10 req/min | Nonce generation is cheap but triggers session writes |
| `POST /auth/verify` | 5 req/min | SIWE verification is CPU-intensive (signature recovery) |
| `GET /auth/me` | 30 req/min | Session reads are fast, but polling should be bounded |
| `POST /auth/logout` | 10 req/min | Session destruction — low frequency operation |

Implementation uses `@fastify/rate-limit`'s route-level `config.rateLimit` option (supported since v8+):

```typescript
app.post('/api/v1/auth/nonce', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
}, async (req, reply) => { ... });
```

---

## 2. Double-Submit CSRF Protection

**Problem:** CORS + `SameSite` cookies provide baseline CSRF protection. However, `SameSite: 'none'` is set in production (required for cross-origin cookie sending from the dashboard), which weakens CSRF defense. The SIWE nonce protects the auth flow, but **non-auth mutations** (POST/PUT/DELETE to `/collections`, `/whitelist`, `/roles`, `/privacy`, etc.) have no CSRF protection beyond CORS.

### Approach: Double-Submit Cookie Pattern

Generate a random CSRF token alongside the SIWE session. Store it in:
1. The session cookie (encrypted, httpOnly) — server-side truth
2. A separate non-httpOnly cookie (`plugport_csrf`) — readable by JS

On every state-changing request (POST/PUT/DELETE), the middleware validates that the `x-csrf-token` header matches the value in the session.

**Why this works:**
- An attacker can't read the CSRF cookie cross-origin (SameSite + CORS blocks it)
- An attacker can't forge the `x-csrf-token` header without reading the cookie
- API key users (`pp_live_*`, `x-api-key`) are exempt — they don't use cookies

### [MODIFY] `packages/server/src/auth/session.ts`

Add `csrfToken` to the `SessionData` interface:

```typescript
export interface SessionData {
    address?: string;
    chainId?: number;
    nonce?: string;
    csrfToken?: string;  // Double-submit CSRF token
}
```

### [MODIFY] `packages/server/src/http-server.ts`

**Auth flow changes:**
- `/auth/verify` (on success): Generate `csrfToken = randomBytes(32).toString('hex')`, store in session, and set a separate `plugport_csrf` cookie (non-httpOnly, same `SameSite`/`secure` flags).
- `/auth/logout`: Clear the `plugport_csrf` cookie.

**Middleware changes:**
- In the `onRequest` hook, after successful session cookie auth (Method 1), for non-GET requests: validate `request.headers['x-csrf-token'] === session.csrfToken`. Return 403 if mismatch.
- Skip CSRF validation for: GET/HEAD/OPTIONS, API key auth, legacy key auth, test backdoor, public endpoints, auth endpoints.

### [MODIFY] `packages/dashboard/src/lib/api.ts`

- Read the `plugport_csrf` cookie value using `document.cookie`.
- Attach `x-csrf-token` header on all `apiPost`/`apiDelete`/`apiPut` calls.

> [!IMPORTANT]
> The `plugport_csrf` cookie must NOT be `httpOnly` so the dashboard JS can read it. It IS `secure` and `SameSite: none` in production — matching the session cookie.

### [NEW] `packages/server/src/__tests__/auth-security.test.ts`

5 tests:
1. Auth rate limit: 6th `/auth/verify` in 1 minute returns 429
2. Auth rate limit: 11th `/auth/nonce` in 1 minute returns 429
3. CSRF: POST mutation without `x-csrf-token` header returns 403 (when session-authed)
4. CSRF: POST mutation with wrong `x-csrf-token` returns 403
5. CSRF: API key auth bypasses CSRF check (no 403)

---

## Verification Plan

### Automated Tests
- `cd packages/server && npx vitest run` — All 203+ tests pass (5 new tests)
- `pnpm --filter @plugport/tests test:integration` — 23 integration tests pass (test backdoor bypasses CSRF)

### Manual Verification
- Verify `/auth/nonce` returns 429 after 10 rapid requests
- Verify dashboard SIWE login flow still works (CSRF cookie set on verify, sent on mutations)
