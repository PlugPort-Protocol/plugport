// Until 2026-09-30 any signed-in wallet could insert into, update, delete from
// or drop any collection that wasn't private: PrivacyManager.hasWriteAccess
// returned true for public and unowned collections, and collections are public
// by default. For a product with paying customers, "public" must mean anyone can
// read — not anyone can write.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../http-server.js';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { MetricsCollector } from '../metrics.js';
import { PrivacyManager } from '../storage/privacy-manager.js';

const ALICE = '0xa11ce00000000000000000000000000000000001';
const BOB = '0xb0b0000000000000000000000000000000000002';
const OPERATOR_KEY = 'operator-master-key';

describe('collection write access', () => {
    let app: FastifyInstance;
    let store: DocumentStore;

    beforeAll(async () => {
        const kvStore = new InMemoryKVStore();
        store = new DocumentStore(kvStore);
        app = await createHttpServer({
            port: 0, host: '127.0.0.1', apiKey: OPERATOR_KEY, store, metrics: new MetricsCollector(), kvStore,
            privacyManager: new PrivacyManager(kvStore),
        });
        await app.ready();
    });
    afterAll(() => app.close());

    const as = (wallet: string) => ({ 'x-test-wallet-address': wallet });
    const call = (headers: Record<string, string>, op: string, coll: string, payload: object) =>
        app.inject({ method: 'POST', url: `/api/v1/collections/${coll}/${op}`, headers, payload });

    it('the first wallet to write a new collection owns it', async () => {
        // Made public explicitly: new collections are private by default (P8).
        expect((await call(as(ALICE), 'privacy', 'alice_notes', { mode: 'public' })).statusCode).toBe(200);
        expect((await call(as(ALICE), 'insertOne', 'alice_notes', { document: { n: 1 } })).statusCode).toBe(200);
        const mine = await app.inject({ method: 'GET', url: `/api/v1/user/${ALICE}/collections`, headers: as(ALICE) });
        expect(mine.json().collections.map((c: { name: string }) => c.name)).toContain('alice_notes');
    });

    it("another wallet can read a public collection but cannot change it", async () => {
        expect((await call(as(BOB), 'find', 'alice_notes', { filter: {} })).json().cursor.firstBatch).toHaveLength(1);

        for (const [op, payload] of [
            ['insertOne', { document: { n: 2 } }],
            ['insertMany', { documents: [{ n: 3 }] }],
            ['updateOne', { filter: {}, update: { $set: { n: 99 } } }],
            ['updateMany', { filter: {}, update: { $set: { n: 99 } } }],
            ['deleteOne', { filter: {} }],
            ['deleteMany', { filter: {} }],
            ['createIndex', { field: 'n' }],
            ['drop', {}],
        ] as const) {
            const res = await call(as(BOB), op, 'alice_notes', payload);
            expect(res.statusCode, op).toBe(403);
            expect(res.json().errmsg).toMatch(/belongs to another wallet/);
        }
        const docs = (await call(as(ALICE), 'find', 'alice_notes', { filter: {} })).json().cursor.firstBatch;
        expect(docs).toEqual([expect.objectContaining({ n: 1 })]);
    });

    it("the SQL endpoint enforces the same rule", async () => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/sql', headers: as(BOB), payload: { query: "INSERT INTO alice_notes (n) VALUES (5)" } });
        expect(res.statusCode).toBe(403);
    });

    it('the owner can write, and can grant another wallet write access', async () => {
        expect((await call(as(ALICE), 'updateOne', 'alice_notes', { filter: { n: 1 }, update: { $set: { n: 10 } } })).statusCode).toBe(200);
        await call(as(ALICE), 'privacy', 'alice_notes', { mode: 'public' });
        const grant = await call(as(ALICE), 'roles', 'alice_notes', { address: BOB, action: 'grant', role: 2 });
        expect(grant.statusCode).toBe(200);
        expect((await call(as(BOB), 'insertOne', 'alice_notes', { document: { by: 'bob' } })).statusCode).toBe(200);
    });

    it('a collection created before ownership existed is read-only for wallets, writable by the operator', async () => {
        await store.insert('legacy_demo', [{ seeded: true }]);
        expect((await call(as(BOB), 'find', 'legacy_demo', { filter: {} })).statusCode).toBe(200);
        const res = await call(as(BOB), 'insertOne', 'legacy_demo', { document: { x: 1 } });
        expect(res.statusCode).toBe(403);
        expect(res.json().errmsg).toMatch(/no owner and is read-only/);
        expect((await call({ 'x-api-key': OPERATOR_KEY }, 'insertOne', 'legacy_demo', { document: { x: 1 } })).statusCode).toBe(200);
    });

    it('two wallets racing to create the same collection: one owns it, the other is refused', async () => {
        const [a, b] = await Promise.all([
            call(as(ALICE), 'insertOne', 'contested', { document: { by: 'alice' } }),
            call(as(BOB), 'insertOne', 'contested', { document: { by: 'bob' } }),
        ]);
        expect([a.statusCode, b.statusCode].sort()).toEqual([200, 403]);
        const winner = a.statusCode === 200 ? ALICE : BOB;
        const docs = (await call(as(winner), 'find', 'contested', { filter: {} })).json().cursor.firstBatch;
        expect(docs).toHaveLength(1);
    });

    it('a new collection is private by default: other wallets cannot read it', async () => {
        expect((await call(as(ALICE), 'insertOne', 'alice_private', { document: { secret: 1 } })).statusCode).toBe(200);
        expect((await call(as(BOB), 'find', 'alice_private', { filter: {} })).statusCode).toBe(403);
        expect((await call(as(ALICE), 'find', 'alice_private', { filter: {} })).json().cursor.firstBatch).toHaveLength(1);
    });
});
