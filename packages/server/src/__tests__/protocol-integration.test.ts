// Protocol Server Integration Tests
// Tests the PlugPort multi-protocol architecture: HTTP API, protocol management, whitelist endpoints

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHttpServer, type HttpServerOptions } from '../http-server.js';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { MetricsCollector } from '../metrics.js';
import type { FastifyInstance } from 'fastify';

describe('Protocol Integration', () => {
    let app: FastifyInstance;
    let store: DocumentStore;
    let kvStore: InMemoryKVStore;

    // Mock protocol manager for testing
    const mockProtocols = [
        { name: 'http', enabled: true, port: 8080, connections: 0, connectionString: 'http://localhost:8080' },
        { name: 'mongodb', enabled: true, port: 27017, connections: 2, connectionString: 'mongodb://localhost:27017' },
        { name: 'postgresql', enabled: false, port: 5432, connections: 0, connectionString: 'postgresql://localhost:5432/plugport' },
        { name: 'mysql', enabled: false, port: 3306, connections: 0, connectionString: 'mysql://root@localhost:3306' },
        { name: 'redis', enabled: true, port: 6379, connections: 1, connectionString: 'redis://localhost:6379' },
    ];

    const mockProtocolManager = {
        getStatus: () => [...mockProtocols],
        enableProtocol: async (name: string) => {
            const p = mockProtocols.find(p => p.name === name);
            if (!p) throw new Error(`Unknown protocol: ${name}`);
            p.enabled = true;
        },
        disableProtocol: async (name: string) => {
            const p = mockProtocols.find(p => p.name === name);
            if (!p) throw new Error(`Unknown protocol: ${name}`);
            p.enabled = false;
        },
    };

    beforeAll(async () => {
        kvStore = new InMemoryKVStore();
        store = new DocumentStore(kvStore);
        const metrics = new MetricsCollector();

        const options: HttpServerOptions = {
            port: 0, // Random port
            host: '127.0.0.1',
            store,
            metrics,
            kvStore,
            protocolManager: mockProtocolManager,
            storageMode: 'public',
            whitelistAddresses: ['0xAABBCC'],
        };

        app = await createHttpServer(options);
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    describe('Health endpoint with protocol info', () => {
        it('should include protocol status in health', async () => {
            const res = await app.inject({ method: 'GET', url: '/health' });
            expect(res.statusCode).toBe(200);

            const body = res.json();
            expect(body.status).toBe('ok');
            expect(body.storageMode).toBe('public');
            expect(body.protocols).toBeDefined();
            expect(body.protocols.length).toBe(5);
        });

        it('should show correct enabled/disabled status', async () => {
            const res = await app.inject({ method: 'GET', url: '/health' });
            const body = res.json();

            const pg = body.protocols.find((p: any) => p.name === 'postgresql');
            expect(pg.enabled).toBe(false);

            const mongo = body.protocols.find((p: any) => p.name === 'mongodb');
            expect(mongo.enabled).toBe(true);
        });
    });

    describe('Protocol management endpoints', () => {
        it('should list protocols via GET /api/v1/protocols', async () => {
            const res = await app.inject({ method: 'GET', url: '/api/v1/protocols' });
            expect(res.statusCode).toBe(200);

            const body = res.json();
            expect(body.protocols.length).toBe(5);
            expect(body.ok).toBe(1);
        });

        it('should enable a protocol', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/protocols/postgresql/enable',
            });
            expect(res.statusCode).toBe(200);

            const body = res.json();
            expect(body.ok).toBe(1);
            expect(body.enabled).toBe(true);
        });

        it('should disable a protocol', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/protocols/postgresql/disable',
            });
            expect(res.statusCode).toBe(200);

            const body = res.json();
            expect(body.ok).toBe(1);
            expect(body.enabled).toBe(false);
        });

        it('should return 400 for unknown protocol', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/protocols/unknown/enable',
            });
            expect(res.statusCode).toBe(400);
        });
    });

    describe('Whitelist management endpoints', () => {
        it('should list whitelisted addresses', async () => {
            const res = await app.inject({ method: 'GET', url: '/api/v1/whitelist' });
            expect(res.statusCode).toBe(200);

            const body = res.json();
            expect(body.addresses).toContain('0xAABBCC');
        });

        it('should add an address to whitelist', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/whitelist',
                payload: { address: '0xDDEEFF', action: 'add' },
            });
            expect(res.statusCode).toBe(200);

            const body = res.json();
            expect(body.addresses).toContain('0xDDEEFF');
        });

        it('should not add duplicate address', async () => {
            // Add the same address twice
            await app.inject({
                method: 'POST',
                url: '/api/v1/whitelist',
                payload: { address: '0x111111', action: 'add' },
            });
            await app.inject({
                method: 'POST',
                url: '/api/v1/whitelist',
                payload: { address: '0x111111', action: 'add' },
            });

            const res = await app.inject({ method: 'GET', url: '/api/v1/whitelist' });
            const body = res.json();
            const count = body.addresses.filter((a: string) => a === '0x111111').length;
            expect(count).toBe(1);
        });

        it('should remove an address from whitelist', async () => {
            // First add
            await app.inject({
                method: 'POST',
                url: '/api/v1/whitelist',
                payload: { address: '0x999999', action: 'add' },
            });

            // Then remove
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/whitelist',
                payload: { address: '0x999999', action: 'remove' },
            });
            expect(res.statusCode).toBe(200);

            const body = res.json();
            expect(body.addresses).not.toContain('0x999999');
        });

        it('should return 400 when address is missing', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/whitelist',
                payload: { action: 'add' },
            });
            expect(res.statusCode).toBe(400);
        });
    });

    describe('Core API operations (cross-protocol data layer)', () => {
        it('should insert and find via HTTP (shared store)', async () => {
            // Insert
            const insertRes = await app.inject({
                method: 'POST',
                url: '/api/v1/collections/test_users/insertOne',
                payload: { document: { name: 'TestUser', email: 'test@test.com' } },
            });
            expect(insertRes.statusCode).toBe(200);

            // Find
            const findRes = await app.inject({
                method: 'POST',
                url: '/api/v1/collections/test_users/find',
                payload: { filter: { name: 'TestUser' } },
            });
            expect(findRes.statusCode).toBe(200);
            const body = findRes.json();
            expect(body.cursor.firstBatch.length).toBe(1);
            expect(body.cursor.firstBatch[0].name).toBe('TestUser');
        });

        it('should create indexes', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/collections/test_users/createIndex',
                payload: { field: 'email', unique: true },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().acknowledged).toBe(true);
        });

        it('should list collections', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/api/v1/collections',
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.collections.length).toBeGreaterThanOrEqual(1);
        });
    });
});
