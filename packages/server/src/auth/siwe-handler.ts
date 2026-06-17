// PlugPort SIWE (Sign-In with Ethereum) Authentication Handler
// Provides nonce generation, signature verification, and JWT token issuance.
// Used for wallet-based authentication in the universal dashboard.

import { randomBytes, createHash } from 'crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { verifyMessage } from 'ethers';

// ---- Types ----

export interface SIWESession {
    address: string;
    chainId: number;
    iat: number;
    exp: number;
}

export interface NonceEntry {
    nonce: string;
    createdAt: number;
    address: string;
}

// ---- SIWE Handler ----

export class SIWEHandler {
    private nonces: Map<string, NonceEntry> = new Map();
    private jwtSecret: Uint8Array;
    private jwtExpirySeconds: number;
    private nonceExpiryMs: number;

    constructor(options?: {
        /** Secret for JWT signing. Defaults to random 32 bytes. */
        jwtSecret?: string;
        /** JWT expiry in seconds. Default: 24 hours. */
        jwtExpirySeconds?: number;
        /** Nonce expiry in milliseconds. Default: 5 minutes. */
        nonceExpiryMs?: number;
    }) {
        const secret = options?.jwtSecret || randomBytes(32).toString('hex');
        this.jwtSecret = new TextEncoder().encode(secret);
        this.jwtExpirySeconds = options?.jwtExpirySeconds || 86400; // 24h
        this.nonceExpiryMs = options?.nonceExpiryMs || 5 * 60 * 1000; // 5 min

        // Periodic cleanup of expired nonces
        setInterval(() => this.cleanupNonces(), 60_000);
    }

    /**
     * Generate a random nonce for SIWE message construction.
     * The nonce is stored server-side with a TTL.
     */
    generateNonce(address: string): string {
        const nonce = randomBytes(16).toString('hex');
        const key = `${address.toLowerCase()}:${nonce}`;

        this.nonces.set(key, {
            nonce,
            createdAt: Date.now(),
            address: address.toLowerCase(),
        });

        return nonce;
    }

    /**
     * Verify a signed SIWE message and issue a JWT.
     *
     * @param message The plaintext SIWE message that was signed
     * @param signature The wallet's signature of the message
     * @param claimedAddress The address the user claims to own
     * @returns JWT token string
     */
    async verify(
        message: string,
        signature: string,
        claimedAddress: string,
    ): Promise<{ token: string; address: string }> {
        const normalizedAddress = claimedAddress.toLowerCase();

        // Step 1: Verify the signature recovers to the claimed address
        let recoveredAddress: string;
        try {
            recoveredAddress = verifyMessage(message, signature).toLowerCase();
        } catch {
            throw new Error('Invalid signature');
        }

        if (recoveredAddress !== normalizedAddress) {
            throw new Error('Signature does not match claimed address');
        }

        // Step 2: Extract and validate nonce from message
        const nonceMatch = message.match(/Nonce: ([a-f0-9]+)/i);
        if (!nonceMatch) {
            throw new Error('Nonce not found in message');
        }
        const nonce = nonceMatch[1];
        const nonceKey = `${normalizedAddress}:${nonce}`;
        const nonceEntry = this.nonces.get(nonceKey);

        if (!nonceEntry) {
            throw new Error('Invalid or expired nonce');
        }

        // Check nonce expiry
        if (Date.now() - nonceEntry.createdAt > this.nonceExpiryMs) {
            this.nonces.delete(nonceKey);
            throw new Error('Nonce expired');
        }

        // Consume nonce (one-time use)
        this.nonces.delete(nonceKey);

        // Step 3: Extract chain ID from message
        const chainIdMatch = message.match(/Chain ID: (\d+)/i);
        const chainId = chainIdMatch ? parseInt(chainIdMatch[1], 10) : 10143;

        // Step 4: Issue JWT
        const now = Math.floor(Date.now() / 1000);
        const token = await new SignJWT({
            address: normalizedAddress,
            chainId,
        } as JWTPayload & { address: string; chainId: number })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt(now)
            .setExpirationTime(now + this.jwtExpirySeconds)
            .setIssuer('plugport')
            .setSubject(normalizedAddress)
            .sign(this.jwtSecret);

        return { token, address: normalizedAddress };
    }

    /**
     * Validate a JWT token and return the session.
     *
     * @param token JWT token string
     * @returns Decoded session with address and chainId
     */
    async validateToken(token: string): Promise<SIWESession> {
        try {
            const { payload } = await jwtVerify(token, this.jwtSecret, {
                issuer: 'plugport',
            });

            return {
                address: (payload as any).address,
                chainId: (payload as any).chainId || 10143,
                iat: payload.iat || 0,
                exp: payload.exp || 0,
            };
        } catch {
            throw new Error('Invalid or expired token');
        }
    }

    /**
     * Clean up expired nonces.
     */
    private cleanupNonces(): void {
        const now = Date.now();
        for (const [key, entry] of this.nonces) {
            if (now - entry.createdAt > this.nonceExpiryMs) {
                this.nonces.delete(key);
            }
        }
    }
}
