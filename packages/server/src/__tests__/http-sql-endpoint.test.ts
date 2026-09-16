// /api/v1/sql HTTP endpoint tests: CREATE TABLE / DROP TABLE / JOIN, plus the
// createIndex validation gap — all found missing/broken in a live QA pass.
// The SQL translator already produced correct 'createCollection' / 'dropCollection'
// / 'join' TranslatedQuery results (proven by sql-translator.test.ts), but
// http-server.ts's /api/v1/sql switch statement had no case for any of the
// three, so every one of them 400'd even though the identical query worked
// fine over the raw PostgreSQL/MySQL wire protocols (pg-server.ts / mysql-server.ts).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHttpServer, type HttpServerOptions } from '../http-server.js';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { MetricsCollector } from '../metrics.js';
import type { FastifyInstance } from 'fastify';

describe('/api/v1/sql — CREATE TABLE / DROP TABLE / JOIN', () => {
    let app: FastifyInstance;
    const headers = { 'x-test-wallet-address': '0xSqlEndpointTester' };

    beforeAll(async () => {
        const kvStore = new InMemoryKVStore();
        const store = new DocumentStore(kvStore);
        const metrics = new MetricsCollector();

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
        };

        app = await createHttpServer(options);
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    it('CREATE TABLE (postgresql dialect) succeeds instead of 400ing as "unsupported operation"', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/sql',
            headers,
            payload: { query: 'CREATE TABLE sql_ep_pg_table (id INT)', dialect: 'postgresql' },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.ok).toBe(1);

        // The collection now genuinely exists.
        const listRes = await app.inject({ method: 'GET', url: '/api/v1/collections', headers });
        const names = listRes.json().collections.map((c: any) => c.name);
        expect(names).toContain('sql_ep_pg_table');
    });

    it('CREATE TABLE (mysql dialect) also succeeds', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/sql',
            headers,
            payload: { query: 'CREATE TABLE sql_ep_mysql_table (id INT)', dialect: 'mysql' },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().ok).toBe(1);
    });

    it('DROP TABLE succeeds and the collection is actually gone', async () => {
        await app.inject({
            method: 'POST',
            url: '/api/v1/sql',
            headers,
            payload: { query: 'CREATE TABLE sql_ep_to_drop (id INT)', dialect: 'postgresql' },
        });

        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/sql',
            headers,
            payload: { query: 'DROP TABLE sql_ep_to_drop', dialect: 'postgresql' },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().ok).toBe(1);

        const listRes = await app.inject({ method: 'GET', url: '/api/v1/collections', headers });
        const names = listRes.json().collections.map((c: any) => c.name);
        expect(names).not.toContain('sql_ep_to_drop');
    });

    it('JOIN across two collections returns correctly merged rows instead of 400ing "collection required"', async () => {
        await app.inject({
            method: 'POST',
            url: '/api/v1/collections/sql_ep_join_users/insertMany',
            headers,
            payload: { documents: [{ userId: 1, name: 'Alice' }, { userId: 2, name: 'Bob' }] },
        });
        await app.inject({
            method: 'POST',
            url: '/api/v1/collections/sql_ep_join_orders/insertMany',
            headers,
            payload: { documents: [{ userId: 1, total: 100 }, { userId: 1, total: 50 }, { userId: 2, total: 75 }] },
        });

        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/sql',
            headers,
            payload: {
                query: 'SELECT * FROM sql_ep_join_users u INNER JOIN sql_ep_join_orders o ON u.userId = o.userId',
                dialect: 'postgresql',
            },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.ok).toBe(1);
        const rows = body.result.cursor.firstBatch as any[];
        expect(rows).toHaveLength(3);
        const totalsForAlice = rows.filter(r => r.name === 'Alice').map(r => r.total).sort((a, b) => a - b);
        expect(totalsForAlice).toEqual([50, 100]);
        const totalsForBob = rows.filter(r => r.name === 'Bob').map(r => r.total);
        expect(totalsForBob).toEqual([75]);
    });

    it('a caller without read access to one joined collection is denied, not silently joined', async () => {
        await app.inject({
            method: 'POST',
            url: '/api/v1/collections/sql_ep_private_join_target/insertOne',
            headers,
            payload: { document: { secret: true } },
        });
        await app.inject({
            method: 'POST',
            url: '/api/v1/collections/sql_ep_private_join_target/privacy',
            headers,
            payload: { mode: 'private' },
        });

        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/sql',
            headers: { 'x-test-wallet-address': '0xUnrelatedWallet' },
            payload: {
                query: 'SELECT * FROM sql_ep_join_users u INNER JOIN sql_ep_private_join_target o ON u.userId = o.userId',
                dialect: 'postgresql',
            },
        });
        expect(res.statusCode).toBe(403);
    });

    it('WHERE ... LIKE actually filters instead of matching every row', async () => {
        await app.inject({
            method: 'POST',
            url: '/api/v1/collections/sql_ep_like_test/insertMany',
            headers,
            payload: {
                documents: [
                    { name: 'Alice' },
                    { name: 'Bob' },
                    { name: 'Alicia' },
                ],
            },
        });

        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/sql',
            headers,
            payload: {
                query: "SELECT * FROM sql_ep_like_test WHERE name LIKE 'Ali%'",
                dialect: 'postgresql',
            },
        });

        expect(res.statusCode).toBe(200);
        const rows = res.json().result.cursor.firstBatch as any[];
        const names = rows.map(r => r.name).sort();
        expect(names).toEqual(['Alice', 'Alicia']);
    });
});

describe('POST /api/v1/collections/:name/createIndex — field validation', () => {
    let app: FastifyInstance;
    const headers = { 'x-test-wallet-address': '0xCreateIndexTester' };

    beforeAll(async () => {
        const kvStore = new InMemoryKVStore();
        const store = new DocumentStore(kvStore);
        const metrics = new MetricsCollector();

        app = await createHttpServer({
            port: 0,
            host: '127.0.0.1',
            store,
            metrics,
            kvStore,
        });
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    it('400s on a missing field instead of silently creating an index named "undefined_N"', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/collections/idx_test_collection/createIndex',
            headers,
            payload: { keys: { region: 1 } }, // wrong param name — no `field`
        });
        expect(res.statusCode).toBe(400);

        const listRes = await app.inject({
            method: 'GET',
            url: '/api/v1/collections/idx_test_collection/indexes',
            headers,
        });
        const indexNames = (listRes.json().indexes || []).map((i: any) => i.name);
        expect(indexNames).not.toContain('undefined_1');
    });

    it('creates a correctly-named index when field is a valid string', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/collections/idx_test_collection/createIndex',
            headers,
            payload: { field: 'region' },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.ok).toBe(1);
        expect(body.indexName).toBe('region_1');
    });
});
