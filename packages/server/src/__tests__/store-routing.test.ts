// Option B: a private collection whose data has been moved into its owner's own
// private store is routed there — and only there — encrypted with that store's
// own key. Real DocumentStore over a RoutingAdapter; every "store" is an
// in-memory KV so the tests can inspect exactly what each one holds.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { RoutingAdapter } from '../storage/routing-adapter.js';
import { EncryptionLayer, deriveStoreRootKey } from '../storage/encryption-layer.js';
import { PrivacyManager } from '../storage/privacy-manager.js';
import { StoreAdapterPool } from '../storage/store-adapter-pool.js';
import { MetricsCollector } from '../metrics.js';
import { createHttpServer } from '../http-server.js';

const ROOT = '7ca9aab926f23abfef41acc9bbae4c81e22c8cb52b7abd78da43533dfc3e3da6';
const ALICE = '0xa11ce00000000000000000000000000000000001';
const BOB = '0xb0b0000000000000000000000000000000000002';
const STORE_A = '0x00000000000000000000000000000000000000aa';
const STORE_B = '0x00000000000000000000000000000000000000bb';
const SECRET = 'alice-top-secret-4242';

function setup() {
    const publicKv = new InMemoryKVStore();
    const sharedKv = new InMemoryKVStore();
    const storeKvs = new Map<string, InMemoryKVStore>();
    const routing = new RoutingAdapter(publicKv, new EncryptionLayer(sharedKv, { privateKey: ROOT, enabled: true }));
    const privacy = new PrivacyManager(routing);
    routing.setPrivacyManager(privacy);
    const pool = new StoreAdapterPool((addr) => {
        const kv = new InMemoryKVStore();
        storeKvs.set(addr.toLowerCase(), kv);
        return new EncryptionLayer(kv, { privateKey: deriveStoreRootKey(ROOT, addr), enabled: true });
    });
    routing.setStorePool(pool);
    const store = new DocumentStore(routing);
    const dump = async (kv: InMemoryKVStore | undefined) =>
        kv ? (await kv.scan({ prefix: '', limit: 10000 })).map((e) => `${e.key} => ${Buffer.from(e.value).toString('utf8')}`).join('\n') : '';
    /** A private collection of `owner` whose data lives in `storeAddress`. */
    const inStore = async (collection: string, owner: string, storeAddress: string) => {
        await privacy.setCollectionPrivacy(collection, 'private', owner);
        await privacy.setStoreAddress(collection, storeAddress);
    };
    return { publicKv, sharedKv, storeKvs, routing, privacy, pool, store, dump, inStore };
}

describe('routing to customer private stores', () => {
    it("puts a collection's documents and index entries only in its owner's store, encrypted", async () => {
        const { store, inStore, publicKv, sharedKv, storeKvs, dump } = setup();
        await inStore('vault', ALICE, STORE_A);
        await store.insert('vault', [{ note: SECRET, email: 'alice@example.com' }]);
        await store.createIndex('vault', 'email');

        const inA = await dump(storeKvs.get(STORE_A));
        expect(inA).toMatch(/doc:vault:/);
        expect(inA).toMatch(/idx:vault:email:/);
        expect(inA).not.toContain(SECRET); // encrypted at rest
        expect(await dump(sharedKv)).not.toMatch(/doc:vault:|idx:vault:/);
        expect(await dump(publicKv)).not.toMatch(/doc:vault:|idx:vault:/);
        expect(await dump(publicKv)).not.toContain(SECRET);

        const found = await store.find('vault', { email: 'alice@example.com' });
        expect(found.cursor.firstBatch).toEqual([expect.objectContaining({ note: SECRET })]);
    });

    it("keeps different customers' stores apart", async () => {
        const { store, inStore, storeKvs, dump } = setup();
        await inStore('a_data', ALICE, STORE_A);
        await inStore('b_data', BOB, STORE_B);
        await store.insert('a_data', [{ who: 'alice' }]);
        await store.insert('b_data', [{ who: 'bob' }]);
        expect(await dump(storeKvs.get(STORE_A))).not.toMatch(/b_data/);
        expect(await dump(storeKvs.get(STORE_B))).not.toMatch(/a_data/);
    });

    it('a private collection without its own store stays in the shared private store', async () => {
        const { store, privacy, sharedKv, storeKvs, dump } = setup();
        await privacy.setCollectionPrivacy('shared_vault', 'private', ALICE);
        await store.insert('shared_vault', [{ x: 1 }]);
        expect(await dump(sharedKv)).toMatch(/doc:shared_vault:/);
        expect(storeKvs.size).toBe(0);
    });

    it('moves a collection from the shared store into the owner store, then back to public', async () => {
        const { store, privacy, routing, sharedKv, publicKv, storeKvs, dump } = setup();
        await privacy.setCollectionPrivacy('moving', 'private', ALICE);
        await store.insert('moving', [{ n: 1 }, { n: 2 }]);

        const moved = await routing.migrateCollection('moving', { store: STORE_A }, () => privacy.setStoreAddress('moving', STORE_A));
        expect(moved).toBeGreaterThanOrEqual(2);
        expect(await dump(sharedKv)).not.toMatch(/doc:moving:/);
        expect(await dump(storeKvs.get(STORE_A))).toMatch(/doc:moving:/);
        expect((await store.find('moving', {})).cursor.firstBatch).toHaveLength(2);

        await routing.migrateCollection('moving', 'public', async () => { await privacy.setCollectionPrivacy('moving', 'public', ALICE); });
        expect((await privacy.getCollectionPrivacy('moving'))?.storeAddress).toBeUndefined();
        expect(await dump(storeKvs.get(STORE_A))).not.toMatch(/doc:moving:/);
        expect(await dump(publicKv)).toMatch(/doc:moving:/);
        expect((await store.find('moving', {})).cursor.firstBatch).toHaveLength(2);
    });

    it("gives each store its own key: one store's data can't be decrypted as another's", async () => {
        const { store, inStore, storeKvs } = setup();
        await inStore('keyed', ALICE, STORE_A);
        await store.insert('keyed', [{ note: SECRET }]);
        const kvA = storeKvs.get(STORE_A)!;
        const asStoreB = new EncryptionLayer(kvA, { privateKey: deriveStoreRootKey(ROOT, STORE_B), enabled: true });
        const docKey = (await kvA.scan({ prefix: 'doc:keyed:', limit: 1 }))[0].key;
        await expect(asStoreB.get(docKey)).rejects.toThrow();
        expect(deriveStoreRootKey(ROOT, STORE_A)).not.toBe(deriveStoreRootKey(ROOT, STORE_B));
    });
});

describe('StoreAdapterPool', () => {
    it('opens a store once, on first use, and drops it after idling', () => {
        let created = 0;
        const pool = new StoreAdapterPool(() => { created++; return new InMemoryKVStore(); }, 1000);
        expect(pool.size).toBe(0);
        const a = pool.get(STORE_A);
        expect(pool.get(STORE_A.toUpperCase().replace('0X', '0x'))).toBe(a);
        expect(created).toBe(1);
        pool.sweep(Date.now() + 1001);
        expect(pool.size).toBe(0);
        pool.close();
    });
});

describe('privacy endpoint and store addresses', () => {
    let app: FastifyInstance;
    let privacy: PrivacyManager;

    beforeAll(async () => {
        const kvStore = new InMemoryKVStore();
        privacy = new PrivacyManager(kvStore);
        app = await createHttpServer({ port: 0, host: '127.0.0.1', store: new DocumentStore(kvStore), metrics: new MetricsCollector(), kvStore, privacyManager: privacy });
        await app.ready();
    });
    afterAll(() => app.close());

    it("never takes a store address from the request (a caller could point a collection at someone else's store)", async () => {
        const res = await app.inject({
            method: 'POST', url: '/api/v1/collections/smuggle/privacy', headers: { 'x-test-wallet-address': ALICE },
            payload: { mode: 'private', contractAddress: STORE_B, storeAddress: STORE_B },
        });
        expect(res.statusCode).toBe(200);
        const record = await privacy.getCollectionPrivacy('smuggle');
        expect(record?.storeAddress).toBeUndefined();
        expect(record?.contractAddress).toBeUndefined();
    });
});
