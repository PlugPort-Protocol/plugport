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
//   If MONAD_PRIVATE_KEY is set: HMAC-SHA256(MONAD_PRIVATE_KEY, "plugport-session-v1")
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
}

// ---- Session Secret Derivation ----

/**
 * Derive a stable session encryption password from the server's private key.
 * Uses HMAC-SHA256 with a domain-separation tag so the derived key is
 * independent of the private key's use for transaction signing.
 *
 * Falls back to a random secret in dev mode (no MONAD_PRIVATE_KEY).
 */
function deriveSessionSecret(): string {
    const privateKey = process.env.MONAD_PRIVATE_KEY;

    if (privateKey) {
        const hmac = createHmac('sha256', privateKey);
        hmac.update('plugport-session-v1');
        return hmac.digest('hex');
    }

    // Dev mode: generate random secret (sessions won't survive restart)
    console.warn(
        '  [Auth] WARNING: No MONAD_PRIVATE_KEY set. Using random session secret.',
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
