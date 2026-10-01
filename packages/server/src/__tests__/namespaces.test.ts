// Per-wallet namespaces (roadmap item 2): each customer has its own collection
// space, so two customers can both have `users`. Plain names are the caller's
// own; another wallet's collection is `0xOwner.name` (HTTP, SQL) or the owner's
// address as the MongoDB database. Collections from before namespaces resolve
// as if already moved, and NamespaceMigration moves them.

import { describe, it, expect } from 'vitest';
import { createHttpServer } from '../http-server.js';
import { handleCommand } from '../wire-server.js';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { MetricsCollector } from '../metrics.js';
import { PrivacyManager } from '../storage/privacy-manager.js';
import { CollectionClaims } from '../storage/collection-claims.js';
import { CollectionAccess } from '../storage/collection-access.js';
import { Namespaces } from '../storage/namespaces.js';
import { NamespaceMigration } from '../storage/namespace-migration.js';
import { SQLTranslator } from '../protocols/sql-translator.js';

const ALICE = '0xa11ce00000000000000000000000000000000001';
const BOB = '0xb0b0000000000000000000000000000000000002';
const MASTER = 'operator-master-key';

async function setup(seed?: (store: DocumentStore, privacy: PrivacyManager) => Promise<void>) {
    const kv = new InMemoryKVStore();
    const store = new DocumentStore(kv);
    const privacy = new PrivacyManager(kv);
    await seed?.(store, privacy);
    const namespaces = new Namespaces(store, privacy);
    await namespaces.load();
    const app = await createHttpServer({ port: 0, host: '127.0.0.1', apiKey: MASTER, store, metrics: new MetricsCollector(), kvStore: kv, privacyManager: privacy, namespaces });
    await app.ready();
    const as = (who: string) => (who === MASTER ? { 'x-api-key': MASTER } : { 'x-test-wallet-address': who });
    const call = async (who: string, op: string, coll: string, payload: object = {}) => {
        const res = await app.inject({ method: 'POST', url: `/api/v1/collections/${coll}/${op}`, headers: as(who), payload });
        return { status: res.statusCode, body: res.json() };
    };
    const find = async (who: string, coll: string) => (await call(who, 'find', coll, { filter: {} })).body.cursor?.firstBatch;
    const list = async (who: string) => (await app.inject({ method: 'GET', url: '/api/v1/collections', headers: as(who) })).json().collections.map((c: { name: string }) => c.name);
    return { kv, store, privacy, namespaces, app, call, find, list };
}

describe('per-wallet namespaces over HTTP', () => {
    it('two wallets each have their own `users`', async () => {
        const { call, find, list, store } = await setup();
        expect((await call(ALICE, 'insertOne', 'users', { document: { who: 'alice' } })).status).toBe(200);
        expect((await call(BOB, 'insertOne', 'users', { document: { who: 'bob' } })).status).toBe(200);
        expect(await find(ALICE, 'users')).toEqual([expect.objectContaining({ who: 'alice' })]);
        expect(await find(BOB, 'users')).toEqual([expect.objectContaining({ who: 'bob' })]);
        // Physically, each lives in its owner's namespace.
        expect((await store.listCollections()).map((c) => c.name).sort()).toEqual([`${ALICE}.users`, `${BOB}.users`]);
        // Each sees its own by the plain name; the other's is private by default.
        expect(await list(ALICE)).toEqual(['users']);
        expect(await list(BOB)).toEqual(['users']);
    });

    it("another wallet's public collection is read by its qualified name, never written", async () => {
        const { call, find, list } = await setup();
        await call(ALICE, 'privacy', 'catalog', { mode: 'public' });
        await call(ALICE, 'insertOne', 'catalog', { document: { sku: 1 } });
        expect(await find(BOB, `${ALICE}.catalog`)).toEqual([expect.objectContaining({ sku: 1 })]);
        expect(await find(BOB, `${ALICE.toUpperCase().replace('0X', '0x')}.catalog`)).toHaveLength(1); // address case doesn't matter
        expect(await list(BOB)).toContain(`${ALICE}.catalog`);
        const write = await call(BOB, 'insertOne', `${ALICE}.catalog`, { document: { sku: 2 } });
        expect(write.status).toBe(403);
        // The plain name is Bob's own (empty), not Alice's.
        expect(await find(BOB, 'catalog')).toEqual([]);
    });

    it("nobody creates collections in another wallet's namespace — not a wallet, not the operator", async () => {
        const { call, store } = await setup();
        const bob = await call(BOB, 'insertOne', `${ALICE}.planted`, { document: { x: 1 } });
        expect(bob.status).toBe(403);
        expect(bob.body.errmsg).toMatch(/namespace of 0xa11ce/);
        expect((await call(MASTER, 'insertOne', `${ALICE}.planted`, { document: { x: 1 } })).status).toBe(403);
        expect(await store.getCollection(`${ALICE}.planted`)).toBeNull();
    });

    it("the operator works in the shared namespace; wallets read shared data until they have their own name", async () => {
        const { call, find, list } = await setup();
        expect((await call(MASTER, 'insertOne', 'demo_products', { document: { p: 1 } })).status).toBe(200);
        expect(await find(BOB, 'demo_products')).toEqual([expect.objectContaining({ p: 1 })]);
        expect(await list(BOB)).toContain('demo_products');
        // Bob's own collection of that name takes over the plain name, for him only.
        await call(BOB, 'insertOne', 'demo_products', { document: { mine: true } });
        expect(await find(BOB, 'demo_products')).toEqual([expect.objectContaining({ mine: true })]);
        expect((await list(BOB)).filter((n: string) => n === 'demo_products')).toHaveLength(1);
        expect(await find(ALICE, 'demo_products')).toEqual([expect.objectContaining({ p: 1 })]);
    });

    it('the SQL endpoint resolves names the same way, including qualified tables', async () => {
        const { app, call } = await setup();
        await call(ALICE, 'privacy', 'orders', { mode: 'public' });
        await call(ALICE, 'insertOne', 'orders', { document: { total: 5 } });
        const sql = (who: string, query: string) => app.inject({ method: 'POST', url: '/api/v1/sql', headers: { 'x-test-wallet-address': who }, payload: { query } });
        expect((await sql(ALICE, 'SELECT * FROM orders')).json().result.cursor.firstBatch).toHaveLength(1);
        expect((await sql(BOB, `SELECT * FROM "${ALICE}".orders`)).json().result.cursor.firstBatch).toHaveLength(1);
        expect((await sql(BOB, 'SELECT * FROM orders')).json().result.cursor.firstBatch).toHaveLength(0);
    });

    it('an aggregation $lookup into a private collection is refused (it used to be read unchecked)', async () => {
        const { call } = await setup();
        await call(ALICE, 'insertOne', 'secrets', { document: { k: 1, s: 'x' } });
        await call(BOB, 'insertOne', 'mine', { document: { k: 1 } });
        const res = await call(BOB, 'aggregate', 'mine', { pipeline: [{ $lookup: { from: `${ALICE}.secrets`, localField: 'k', foreignField: 'k', as: 'leak' } }] });
        expect(res.status).toBe(403);
    });
});

describe('collections from before namespaces', () => {
    const seedLegacy = async (store: DocumentStore, privacy: PrivacyManager) => {
        await store.createIndex('users', 'email', true);
        await store.insert('users', [{ _id: 'u1', email: 'a@x' }, { _id: 'u2', email: 'b@x' }]);
        await privacy.setCollectionPrivacy('users', 'public', ALICE);
        await privacy.grantAccess('users', BOB, 2, ALICE);
        await store.insert('shared_demo', [{ demo: true }]);
    };

    it('resolve as if already in the owner namespace', async () => {
        const { find, list } = await setup(seedLegacy);
        expect(await find(ALICE, 'users')).toHaveLength(2);
        expect(await find(BOB, `${ALICE}.users`)).toHaveLength(2);
        expect(await list(ALICE)).toEqual(expect.arrayContaining(['users', 'shared_demo']));
        expect(await list(BOB)).toEqual(expect.arrayContaining([`${ALICE}.users`, 'shared_demo']));
    });

    it('move into it with their documents, indexes and settings; the shared data stays', async () => {
        const { store, privacy, namespaces, find, list, call } = await setup(seedLegacy);
        const status = await new NamespaceMigration(store, privacy, namespaces, 1).run();
        expect(status).toMatchObject({ state: 'done', total: 1, moved: 1 });

        expect(await store.getCollection('users')).toBeNull();
        expect(await privacy.getCollectionPrivacy('users')).toBeNull();
        const moved = await store.getCollection(`${ALICE}.users`);
        expect(moved?.indexes.map((i) => i.field)).toContain('email');
        expect(await privacy.getCollectionPrivacy(`${ALICE}.users`)).toMatchObject({ ownerAddress: ALICE, mode: 'public', accessRoles: { [BOB]: 2 } });
        expect((await find(ALICE, 'users')).map((d: { _id: string }) => d._id).sort()).toEqual(['u1', 'u2']);
        // Bob keeps the write access Alice granted him.
        expect((await call(BOB, 'insertOne', `${ALICE}.users`, { document: { email: 'c@x' } })).status).toBe(200);
        // The unique index came along.
        expect((await call(ALICE, 'insertOne', 'users', { document: { email: 'a@x' } })).status).not.toBe(200);
        expect(await store.getCollection('shared_demo')).not.toBeNull();
        expect(await list(ALICE)).toEqual(expect.arrayContaining(['users', 'shared_demo']));
    });

    it('a move interrupted after the switch-over only finishes the cleanup', async () => {
        const { store, privacy, namespaces, find } = await setup(async (s, p) => {
            await seedLegacy(s, p);
            // The copy completed and the switch was recorded, then the process died mid-cleanup.
            await s.insert(`${ALICE}.users`, [{ _id: 'u1', email: 'a@x' }, { _id: 'u2', email: 'b@x' }]);
            await p.copyRecord('users', `${ALICE}.users`);
            await p.markMoved('users', `${ALICE}.users`);
            await s.deleteOne('users', { _id: 'u1' });
        });
        expect(namespaces.legacyCollections()).toEqual([]);
        expect(await find(ALICE, 'users')).toHaveLength(2); // served from the new name already
        expect(await new NamespaceMigration(store, privacy, namespaces, 1).run()).toMatchObject({ state: 'done', moved: 1 });
        expect(await store.getCollection('users')).toBeNull();
        expect(await privacy.getCollectionPrivacy('users')).toBeNull();
        expect(await find(ALICE, 'users')).toHaveLength(2);
    });

    it('a retry after the switch-over never copies again from the half-deleted original', async () => {
        const { privacy, namespaces } = await setup(seedLegacy);
        const calls: string[] = [];
        const flaky = {
            // Copies and switches over, then the cleanup of the original fails.
            renameCollection: async (_from: string, _to: string, hooks: { prepare(): Promise<void>; switchOver(): Promise<void> }) => {
                calls.push('rename');
                await hooks.prepare();
                await hooks.switchOver();
                throw new Error('RPC timeout while deleting the original');
            },
            dropCollection: async () => { calls.push('drop'); return true; },
        };
        const status = await new NamespaceMigration(flaky, privacy, namespaces, 1).run();
        expect(calls).toEqual(['rename', 'drop']);
        expect(status).toMatchObject({ state: 'done', moved: 1 });
    });

    it('a move interrupted before the switch-over is redone from the intact original', async () => {
        const { store, privacy, namespaces, find } = await setup(async (s, p) => {
            await seedLegacy(s, p);
            await s.insert(`${ALICE}.users`, [{ _id: 'u1', email: 'a@x' }]); // half a copy
        });
        expect(await find(ALICE, 'users')).toHaveLength(2); // still the original
        await new NamespaceMigration(store, privacy, namespaces, 1).run();
        expect((await find(ALICE, 'users')).map((d: { _id: string }) => d._id).sort()).toEqual(['u1', 'u2']);
    });
});

describe('MongoDB: the owner address as the database', () => {
    it("lists and reads a wallet's collections by their plain names in its database", async () => {
        const kv = new InMemoryKVStore();
        const store = new DocumentStore(kv);
        const privacy = new PrivacyManager(kv);
        const claims = new CollectionClaims(privacy);
        const ownership = { owners: new Map([[1, ALICE], [2, BOB]]), access: new CollectionAccess(privacy, store, claims), namespaces: new Namespaces(store, privacy) };
        const run = (conn: number, body: Record<string, unknown>) => handleCommand(store, { $db: 'test', ...body }, [], conn, true, MASTER, new Set([1, 2]), ownership) as Promise<any>;

        await run(1, { create: 'profile', plugportMode: 'public' });
        await run(1, { insert: 'profile', documents: [{ bio: 'hi' }] });
        await run(2, { insert: 'profile', documents: [{ bio: 'bob' }] });

        const inAlice = await run(2, { $db: ALICE, listCollections: 1 });
        expect(inAlice.cursor.firstBatch.map((c: { name: string }) => c.name)).toEqual(['profile']);
        const read = await run(2, { $db: ALICE, find: 'profile', filter: {} });
        expect(read.cursor.firstBatch).toEqual([expect.objectContaining({ bio: 'hi' })]);
        expect(read.cursor.ns).toBe(`${ALICE}.profile`);
        expect((await run(2, { find: 'profile', filter: {} })).cursor.firstBatch).toEqual([expect.objectContaining({ bio: 'bob' })]);
    });
});

describe('SQL: an address schema names another wallet\'s table', () => {
    it('folds it into the collection name; other schemas are ignored as before', () => {
        const pg = new SQLTranslator({ dialect: 'PostgreSQL' });
        const mixed = '0xA11CE00000000000000000000000000000000001';
        expect(pg.translate(`SELECT * FROM "${mixed}".users`).collection).toBe(`${ALICE}.users`);
        expect(pg.translate('SELECT * FROM public.users').collection).toBe('users');
        expect(new SQLTranslator({ dialect: 'MySQL' }).translate(`SELECT * FROM ${mixed}.users`).collection).toBe(`${ALICE}.users`);
        const join = pg.translate(`SELECT * FROM orders o JOIN "${mixed}".users u ON o.uid = u.id`);
        expect(join.joinPlan).toMatchObject({ leftCollection: 'orders', rightCollection: `${ALICE}.users`, rightAlias: 'u' });
    });
});
