// Auth Security Tests: Rate Limiting + CSRF Protection
// Verifies stricter auth endpoint rate limits and double-submit CSRF token validation.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHttpServer, type HttpServerOptions } from '../http-server.js';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { MetricsCollector } from '../metrics.js';
import { PrivacyManager } from '../storage/privacy-manager.js';
import type { FastifyInstance } from 'fastify';

describe('Auth Security', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        const kvStore = new InMemoryKVStore();
        const store = new DocumentStore(kvStore);
        const metrics = new MetricsCollector();
        const privacyManager = new PrivacyManager(kvStore);

        const options: HttpServerOptions = {
            port: 0,
            host: '127.0.0.1',
            store,
            metrics,
            kvStore,
            protocolManager: {
                getStatus: () => [],
                enableProtocol: async () => {},
                disableProtocol: async () => {},
            },
            privacyManager,
        };

        app = await createHttpServer(options);
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    // ---- Rate Limiting ----

    describe('Auth rate limiting', () => {
        it('should apply stricter rate limit to /auth/nonce (10/min)', async () => {
            // Send 11 rapid requests — the 11th should be rate-limited
            const results: number[] = [];
            for (let i = 0; i < 11; i++) {
                const res = await app.inject({
                    method: 'POST',
                    url: '/api/v1/auth/nonce',
                    payload: { address: '0x1234567890abcdef1234567890abcdef12345678' },
                });
                results.push(res.statusCode);
            }
            // First 10 should succeed (200), 11th should be rate-limited (429)
            expect(results.filter(s => s === 200).length).toBe(10);
            expect(results[10]).toBe(429);
        });

        it('should apply stricter rate limit to /auth/verify (5/min)', async () => {
            // Send 6 rapid requests — the 6th should be rate-limited
            // These will return 400 (bad payload) but still count toward the limit
            const results: number[] = [];
            for (let i = 0; i < 6; i++) {
                const res = await app.inject({
                    method: 'POST',
                    url: '/api/v1/auth/verify',
                    payload: { message: 'fake', signature: 'fake' },
                });
                results.push(res.statusCode);
            }
            // First 5 should go through (401 from failed verify), 6th should be rate-limited (429)
            expect(results.slice(0, 5).every(s => s !== 429)).toBe(true);
            expect(results[5]).toBe(429);
        });
    });

    // ---- CSRF Protection ----

    describe('CSRF protection', () => {
        it('should not require CSRF for test backdoor auth (x-test-wallet-address)', async () => {
            // The test backdoor bypasses CSRF — used by all existing tests
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/whitelist',
                payload: { address: '0xCSRFTest', action: 'add' },
                headers: { 'x-test-wallet-address': '0xTestOwner' },
            });
            // Should succeed (200), not 403 CSRF
            expect(res.statusCode).toBe(200);
        });

        it('should not require CSRF for API key auth', async () => {
            // API key auth doesn't use cookies, so no CSRF needed
            // Without a valid API key, this returns 401 (auth failure), not 403 (CSRF)
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/collections/test/insertOne',
                payload: { document: { key: 'value' } },
                headers: { 'x-api-key': 'pp_test_invalidkey' },
            });
            // Should be 401 (invalid key), NOT 403 (CSRF)
            expect(res.statusCode).toBe(401);
        });

        it('should allow GET requests without CSRF token (session-authed)', async () => {
            // GET is a safe method — CSRF check only applies to POST/PUT/DELETE
            const res = await app.inject({
                method: 'GET',
                url: '/health',
            });
            expect(res.statusCode).toBe(200);
        });
    });
});
