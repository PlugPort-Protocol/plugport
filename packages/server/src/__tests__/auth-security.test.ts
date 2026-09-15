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
                getActiveProtocols: () => [],
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

// ---- Soft-public listing endpoints (Overview/Protocols tabs, wallet disconnected) ----
//
// A separate server instance with a legacy apiKey configured — proves the
// disconnected-wallet fix is narrowly scoped: /api/v1/collections and
// /api/v1/protocols stay viewable with no credentials, while every other
// legacy-key-gated route keeps returning 401 exactly as before.

describe('Soft-public listing endpoints', () => {
    let app: FastifyInstance;
    let store: DocumentStore;
    let privacyManager: PrivacyManager;
    const LEGACY_KEY = 'test-legacy-api-key';

    beforeAll(async () => {
        const kvStore = new InMemoryKVStore();
        store = new DocumentStore(kvStore);
        const metrics = new MetricsCollector();
        privacyManager = new PrivacyManager(kvStore);

        const options: HttpServerOptions = {
            port: 0,
            host: '127.0.0.1',
            store,
            metrics,
            kvStore,
            apiKey: LEGACY_KEY,
            protocolManager: {
                getActiveProtocols: () => [
                    { name: 'mongodb', enabled: true, port: 27017, connections: 0, connectionString: 'mongodb://localhost:27017' },
                ],
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

    it('GET /api/v1/collections succeeds with zero credentials despite a configured legacy apiKey', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/collections' });
        expect(res.statusCode).toBe(200);
        expect(res.json().ok).toBe(1);
    });

    it('GET /api/v1/protocols succeeds with zero credentials despite a configured legacy apiKey', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/protocols' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.ok).toBe(1);
        expect(body.protocols).toHaveLength(1);
        expect(body.isDeployer).toBe(false); // anonymous caller is never the deployer
    });

    it('does NOT relax auth for other routes — a write still requires real credentials', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/collections/some-collection/insertOne',
            payload: { document: { a: 1 } },
        });
        expect(res.statusCode).toBe(401);
    });

    it('does NOT relax auth for an unrelated read route', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/keys' });
        expect(res.statusCode).toBe(401);
    });

    it('filters a private collection out of the anonymous listing', async () => {
        await store.insert('private_stuff', [{ secret: 'shh' }] as any);
        await privacyManager.setCollectionPrivacy('private_stuff', 'private', '0xowner');

        const anon = await app.inject({ method: 'GET', url: '/api/v1/collections' });
        const anonNames = anon.json().collections.map((c: { name: string }) => c.name);
        expect(anonNames).not.toContain('private_stuff');
    });

    it('still shows the owner their own private collection', async () => {
        await store.insert('owner_only', [{ secret: 'mine' }] as any);
        await privacyManager.setCollectionPrivacy('owner_only', 'private', '0xowner');

        const asOwner = await app.inject({
            method: 'GET',
            url: '/api/v1/collections',
            headers: { 'x-test-wallet-address': '0xowner' },
        });
        const names = asOwner.json().collections.map((c: { name: string }) => c.name);
        expect(names).toContain('owner_only');
    });

    it('still lists public collections for an anonymous caller', async () => {
        await store.insert('public_stuff', [{ visible: true }] as any);

        const anon = await app.inject({ method: 'GET', url: '/api/v1/collections' });
        const anonNames = anon.json().collections.map((c: { name: string }) => c.name);
        expect(anonNames).toContain('public_stuff');
    });
});
