// PlugPort Session Manager
// Encrypted cookie-based sessions using iron-session + official SIWE package.
// No JWTs. No in-memory state. Fully stateless and multi-replica safe.
//
// Session lifecycle:
//   1. GET  /auth/nonce   → generates nonce, stores in session cookie
//   2. POST /auth/verify  → verifies SIWE message + signature, sets session cookie
//   3. GET  /auth/me      → reads session from cookie
//   4. POST /auth/logout  → destroys session cookie
//
// Session secret derivation:
//   If SESSION_SECRET is set: HMAC-SHA256(SESSION_SECRET, "plugport-session-v1")
//   Else, for existing single-key deployments, the same HMAC over MONAD_PRIVATE_KEY
//   Otherwise: random 32 bytes (dev mode — sessions lost on restart, acceptable)

import { createHmac, randomBytes } from 'crypto';
import type { SessionOptions } from 'iron-session';

// ---- Session Data Shape ----

export interface SessionData {
    /** Verified wallet address (lowercase, checksummed) */
    address?: string;
    /** Chain ID from the SIWE message */
    chainId?: number;
    /** Pre-auth: pending nonce for SIWE verification */
    nonce?: string;
    /** Double-submit CSRF token for mutation protection */
    csrfToken?: string;
}

// ---- Session Secret Derivation ----

/**
 * Derive a stable session encryption password.
 *
 * Prefers SESSION_SECRET — an independent secret with no on-chain authority —
 * so the cookie-signing key isn't tied to a wallet key. MONAD_PRIVATE_KEY is
 * still honoured as a fallback so existing deployments keep their sessions.
 * Uses HMAC-SHA256 with a domain-separation tag either way.
 *
 * Falls back to a random secret in dev mode (nothing configured).
 */
export function deriveSessionSecret(env: Record<string, string | undefined> = process.env): string {
    const seed = env.SESSION_SECRET?.trim() || env.MONAD_PRIVATE_KEY?.trim();

    if (seed) {
        const hmac = createHmac('sha256', seed);
        hmac.update('plugport-session-v1');
        return hmac.digest('hex');
    }

    // Dev mode: generate random secret (sessions won't survive restart)
    console.warn(
        '  [Auth] WARNING: No SESSION_SECRET (or legacy MONAD_PRIVATE_KEY) set. Using random session secret.',
    );
    console.warn(
        '  [Auth] Sessions will not persist across server restarts.',
    );
    return randomBytes(32).toString('hex');
}

// ---- Session Options ----

/**
 * iron-session configuration.
 * The password must be at least 32 characters.
 */
export function getSessionOptions(): SessionOptions {
    return {
        password: deriveSessionSecret(),
        cookieName: 'plugport_session',
        cookieOptions: {
            secure: process.env.NODE_ENV === 'production',
            httpOnly: true,
            sameSite: process.env.NODE_ENV === 'production' ? 'none' as const : 'lax' as const,
            maxAge: 60 * 60 * 24, // 24 hours (in seconds)
        },
    };
}
