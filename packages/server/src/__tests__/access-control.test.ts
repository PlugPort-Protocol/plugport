// T1: Access control tests for count, distinct, and user-scoped endpoints
// Verifies S2 (count/distinct ACL), S3 (user endpoint auth), S5 (gas station auth) fixes.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHttpServer, type HttpServerOptions } from '../http-server.js';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { MetricsCollector } from '../metrics.js';
import { PrivacyManager } from '../storage/privacy-manager.js';
import type { FastifyInstance } from 'fastify';

describe('Access Control Integration', () => {
    let app: FastifyInstance;
    let store: DocumentStore;
    let kvStore: InMemoryKVStore;
    let privacyManager: PrivacyManager;

    beforeAll(async () => {
        kvStore = new InMemoryKVStore();
        store = new DocumentStore(kvStore);
        const metrics = new MetricsCollector();
        privacyManager = new PrivacyManager(kvStore);

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

        // Seed a public collection via HTTP (same as real usage)
        await app.inject({
            method: 'POST',
            url: '/api/v1/collections/public_col/insertOne',
            payload: { document: { name: 'Alice', age: 30 } },
        });
        await app.inject({
            method: 'POST',
            url: '/api/v1/collections/public_col/insertOne',
            payload: { document: { name: 'Bob', age: 25 } },
        });

        // Set up a private collection
        await privacyManager.setCollectionPrivacy(
            'private_col',
            'private',
            '0xowner1234567890abcdef1234567890abcdef1234',
        );
    });

    afterAll(async () => {
        await app.close();
    });

    // ---- S2: count and distinct require access control ----

    describe('S2: count/distinct access control', () => {
        it('should allow count on public collections without auth', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/collections/public_col/count',
                payload: { filter: {} },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.count).toBeGreaterThanOrEqual(2);
        });

        it('should reject count on private collections without auth', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/collections/private_col/count',
                payload: { filter: {} },
            });
            // Should reject — either 401 (no auth) or 403 (no access)
            expect(res.statusCode).toBeGreaterThanOrEqual(400);
        });

        it('should allow distinct on public collections', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/collections/public_col/distinct',
                payload: { field: 'name' },
            });
            expect(res.statusCode).toBe(200);
        });

        it('should reject distinct on private collections without auth', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/collections/private_col/distinct',
                payload: { field: 'name' },
            });
            expect(res.statusCode).toBeGreaterThanOrEqual(400);
        });
    });

    // ---- S3: user-scoped endpoints require auth ----

    describe('S3: user endpoint auth', () => {
        it('should reject user collections without auth', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/v1/user/0xsome_address/collections',
            });
            expect(res.statusCode).toBe(401);
        });

        it('should reject user metrics without auth', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/v1/user/0xsome_address/metrics',
            });
            expect(res.statusCode).toBe(401);
        });
    });

    // ---- S5: gas station balance requires auth ----

    describe('S5: gas station auth', () => {
        it('should reject gas station balance check without auth', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/v1/deploy/gas-station/0x1234567890abcdef1234567890abcdef12345678/balance',
            });
            expect(res.statusCode).toBe(401);
        });

        it('should reject invalid address format (without auth)', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/v1/deploy/gas-station/not-an-address/balance',
            });
            // Without auth, fails at auth check first (401)
            expect(res.statusCode).toBeGreaterThanOrEqual(400);
        });
    });

    // ---- N1: GET /roles requires auth + ownership ----

    describe('N1: roles endpoint auth', () => {
        it('should reject GET /roles without auth', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/v1/collections/private_col/roles',
            });
            expect(res.statusCode).toBe(401);
        });

        it('should reject GET /roles for non-owner', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/v1/collections/private_col/roles',
                headers: { 'x-test-wallet-address': '0xnottheowner' },
            });
            expect(res.statusCode).toBe(403);
        });
    });

    // ---- N3: POST /whitelist requires auth ----

    describe('N3: whitelist mutation auth', () => {
        it('should reject POST /whitelist without auth', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/whitelist',
                payload: { address: '0x123', action: 'add' },
            });
            expect(res.statusCode).toBe(401);
        });
    });
});
