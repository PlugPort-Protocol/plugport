# Replace Custom SIWE Handler with `siwe` + `iron-session`

Replace the hand-rolled `siwe-handler.ts` (custom JWT + in-memory nonce store) with the official `siwe` npm package and `iron-session` encrypted cookies. This eliminates JWTs entirely, fixes the restart-logout bug (S1), the multi-replica nonce issue (A5), and adopts the modern EIP-4361 standard.

## Impact Analysis

### What Changes

| Component | Impact | Why |
|-----------|--------|-----|
| `packages/server/src/auth/siwe-handler.ts` | **DELETE** | Replaced by `siwe` package + `iron-session` |
| `packages/server/src/auth/index.ts` | Modify | Remove `SIWEHandler` export |
| `packages/server/src/http-server.ts` | Modify | Auth middleware switches from JWT Bearer to cookie-based sessions |
| `packages/server/package.json` | Modify | Remove `jose`, add `iron-session`, `@fastify/cookie` |
| `packages/dashboard/src/lib/auth-context.tsx` | Modify | Uses `siwe` message class, cookie-based auth (no manual JWT storage) |
| `packages/dashboard/src/lib/api.ts` | Modify | Remove JWT Bearer header logic, add `credentials: 'include'` |
| `packages/dashboard/package.json` | Modify | Add `siwe` |
| `packages/server/.env.example` | Modify | Remove `JWT_SECRET` mention, add `SESSION_SECRET` (derived from `MONAD_PRIVATE_KEY`) |
| Docs | Modify | Update auth section |

### What Does NOT Change

| Component | Reason |
|-----------|--------|
| `packages/sdk/` | Uses `x-api-key` header only — no JWT, no cookies |
| `packages/cli/` | Uses `x-api-key` header only |
| `packages/sqlite-compat/` | No auth dependency |
| `packages/shared/` | No auth types affected |
| Smart contracts | Auth is off-chain |
| Integration tests | Use `x-test-wallet-address` header bypass, no JWT |
| API key system | Completely independent (`pp_live_`/`pp_test_` keys, `ApiKeyManager`) |
| Privacy system | No JWT dependency |
| Wire protocol auth | SCRAM-based, separate from HTTP auth |

## Proposed Changes

---

### Server Auth Module

#### [DELETE] `siwe-handler.ts`

Delete entirely. The `SIWEHandler` class, `SIWESession` type, in-memory nonce `Map`, and JWT issuance/validation are all replaced.

#### [NEW] `packages/server/src/auth/session.ts`

New session handler using the official `siwe` package:

- **Nonce generation**: Use `siwe.generateNonce()` instead of custom `randomBytes(16).toString('hex')`
- **Message parsing + verification**: Use `new SiweMessage(message).verify({ signature })` — handles domain binding, nonce validation, expiry, chain ID, and EIP-4361 compliance
- **Session storage**: `iron-session` encrypts session data into an httpOnly cookie. No server-side state at all — fully stateless, no `Map`, no JWT secret
- **Session secret derivation**: `HMAC-SHA256(MONAD_PRIVATE_KEY, "plugport-session")` — zero new env vars. Falls back to random bytes in dev mode (non-persistent, but acceptable for dev)

Session shape:
```typescript
interface SessionData {
    address: string;   // Verified wallet address (lowercase)
    chainId: number;   // Chain ID from SIWE message
    nonce?: string;    // Pre-auth: pending nonce
}
```

#### [MODIFY] `index.ts`

Remove `SIWEHandler` / `SIWESession` export, add `sessionOptions` and `SessionData` exports.

---

### Server HTTP Layer

#### [MODIFY] `http-server.ts`

**Auth middleware** (lines 86-147): Replace JWT Bearer token validation with `iron-session` cookie deserialization:

```diff
- if (authHeader?.startsWith('Bearer ')) {
-     const token = authHeader.slice(7);
-     if (token.includes('.')) {
-         const session = await siweHandler.validateToken(token);
-         request.user = { address: session.address, authMethod: 'wallet' };
-     }
- }
+ const session = request.session;
+ if (session?.address) {
+     request.user = { address: session.address, authMethod: 'wallet' };
+ }
```

**Auth endpoints** (lines 724-757): Replace 3 endpoints:

| Endpoint | Before | After |
|----------|--------|-------|
| `POST /api/v1/auth/nonce` | Custom `randomBytes` nonce, stored in Map | `siwe.generateNonce()`, stored in session cookie |
| `POST /api/v1/auth/verify` | Manual regex parse + `ethers.verifyMessage` + JWT issuance | `SiweMessage.verify()` — sets session cookie |
| `GET /api/v1/auth/me` | Reads from JWT | Reads from session cookie |
| `POST /api/v1/auth/logout` | **NEW** | Destroys session cookie |

**Remove** `jwtSecret` from `HttpServerOptions` interface.

**Add** `@fastify/cookie` registration and session middleware.

---

### Server Dependencies

#### [MODIFY] `package.json`

```diff
  "dependencies": {
+   "@fastify/cookie": "^11.0.0",
+   "iron-session": "^8.0.0",
    "ethers": "^6.13.0",
-   "jose": "^5.9.0",
    "siwe": "^2.3.0",  // already present
  }
```

> [!NOTE]
> `siwe` is already in `package.json` at `^2.3.0` but **not actually imported anywhere** — the current handler hand-rolls everything. Now we'll actually use it.

---

### Dashboard Auth

#### [MODIFY] `auth-context.tsx`

Major simplification:

- **Remove**: JWT state (`jwt`, `setJwt`, `setJwtState`), all `localStorage` JWT persistence (`plugport_jwt`)
- **Remove**: Manual SIWE message construction (the string-joining on lines 124-135)
- **Add**: Use `siwe` package's `SiweMessage` class for proper EIP-4361 message formatting
- **Auth state**: `isAuthenticated` is now determined by calling `/api/v1/auth/me` on mount (cookie is sent automatically) instead of checking a local JWT variable
- **signIn flow**: Same 4 steps (nonce → message → sign → verify), but the verify response sets an httpOnly cookie instead of returning a JWT
- **signOut**: Calls `POST /api/v1/auth/logout` to destroy the session cookie

#### [MODIFY] `api.ts`

- **Remove**: `setAuthToken()` function and `_authToken` module variable
- **Remove**: `Bearer ${_authToken}` header injection
- **Add**: `credentials: 'include'` to all `fetch()` calls (sends httpOnly cookie automatically)

#### [MODIFY] `page.tsx`

- **Remove**: `setAuthToken` import and the `useEffect` that syncs JWT to the API client (lines 167-170)

#### [MODIFY] `package.json`

```diff
  "dependencies": {
+   "siwe": "^2.3.0",
  }
```

---

### Config & Env

#### [MODIFY] `.env.example`

No new env vars needed. Session secret is derived from `MONAD_PRIVATE_KEY`. Add a comment explaining this:

```env
# Session encryption is derived from MONAD_PRIVATE_KEY automatically.
# No separate JWT_SECRET is needed.
```

---

### Documentation

#### [MODIFY] `configuration.md`

- Remove `JWT_SECRET` row from env var table
- Update auth section: "JWT Bearer (SIWE)" → "Cookie-based (SIWE)" 
- Note that session is encrypted via `iron-session`, secret is derived from `MONAD_PRIVATE_KEY`

#### [MODIFY] `architecture.md`

- Update Triple-Auth description: "SIWE JWT Bearer" → "SIWE Cookie Session"

---

## Open Questions

> [!IMPORTANT]
> **CORS `credentials: 'include'`**: The dashboard and server may be on different origins (e.g., `plugport.xyz` dashboard → `api.plugport.xyz` server). Cookie-based auth requires the server CORS config to specify the exact origin (not `origin: true` wildcard). The current CORS config uses `origin: true`. Should I:
> - **A)** Lock CORS origin to `NEXT_PUBLIC_DASHBOARD_URL` env var (stricter, production-ready)
> - **B)** Keep `origin: true` but add `credentials: true` (works for dev, less secure in production)
> - **C)** Only use cookies when same-origin; fall back to a short-lived token for cross-origin (hybrid approach)

## Verification Plan

### Automated Tests
- `pnpm --filter @plugport/server test` — verify existing tests still pass (they don't use SIWE)
- `pnpm --filter @plugport/tests test:integration` — verify HTTP API tests pass (use test header bypass)

### Manual Verification
- Start server + dashboard locally
- Connect MetaMask → verify auto-SIWE flow triggers
- Verify session persists across page refresh (no re-sign required)
- Restart server → verify session survives (cookie is self-contained)
- Test sign-out flow
- Verify API key auth (`pp_test_*`) still works independently
