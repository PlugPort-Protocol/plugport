# Auth Rate Limiting + CSRF Protection Tasks

## Server Changes
- [x] Add route-level rate limits to 4 auth endpoints
- [x] Add `csrfToken` to `SessionData` interface
- [x] Generate CSRF token + set cookie on `/auth/verify`
- [x] Clear CSRF cookie on `/auth/logout`
- [x] Add CSRF validation to `onRequest` middleware (POST/PUT/DELETE, session-only)

## Dashboard Changes
- [x] Read `plugport_csrf` cookie and attach `x-csrf-token` header in `api.ts`

## Tests
- [x] Create `auth-security.test.ts` with rate limit + CSRF tests
- [x] Run server unit tests — **208 passed** ✅
- [x] Run dashboard CSS tests — **18 passed** ✅
- [x] Run integration tests — **23 passed** ✅

## Verification
- [x] All 249 tests pass ✅
