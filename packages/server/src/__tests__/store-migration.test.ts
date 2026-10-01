// P7: moving data between stores. Writes pause during a move (a write that
// slipped in between the copy and the switch used to be lost), the privacy
// switch requires an explicit confirm after showing an estimate, and linking a
// customer store moves that wallet's private collections into it.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ethers } from 'ethers';
import type { FastifyInstance } from 'fastify';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { RoutingAdapter, CollectionBusyError } from '../storage/routing-adapter.js';
import { EncryptionLayer, deriveStoreRootKey } from '../storage/encryption-layer.js';
import { PrivacyManager } from '../storage/privacy-manager.js';
import { StoreAdapterPool } from '../storage/store-adapter-pool.js';
import { PrivateStoreRegistry } from '../storage/private-store-registry.js';
import { StoreMigrations } from '../storage/store-migrations.js';
import { MetricsCollector } from '../metrics.js';
import { createHttpServer } from '../http-server.js';

const ROOT = '7ca9aab926f23abfef41acc9bbae4c81e22c8cb52b7abd78da43533dfc3e3da6';
const ALICE = '0xa11ce00000000000000000000000000000000001';
const WRITER = '0xd3C3353894816cDAEA9FBC3a06fA8aeB21f413EA';
const STORE_A = ethers.getAddress('0x00000000000000000000000000000000000000aa');

/** The chain as the registry sees it: STORE_A, deployed for Alice, naming our writer. */
const iface = new ethers.Interface(['function storeOwner(address) view returns (address)', 'function owner() view returns (address)', 'function gasStation() view returns (address)']);
const fakeChain = { async call(tx: { data: string }) {
    const fn = iface.parseTransaction({ data: tx.data })!;
    return iface.encodeFunctionResult(fn.name, [fn.name === 'gasStation' ? WRITER : ALICE]);
} } as unknown as ethers.Provider;

/** In-memory KV whose puts can be held open, to simulate a write still in flight. */
class SlowKV extends InMemoryKVStore {
    hold?: Promise<void>;
    batches = 0;
    override async put(key: string, value: Buffer | Uint8Array) {
        if (this.hold) await this.hold;
        return super.put(key, value);
    }
    override async batchWrite(puts: { key: string; value: Buffer | Uint8Array }[], deletes: string[]) {
        this.batches++;
        if (this.hold) await this.hold;
        return super.batchWrite(puts, deletes);
    }
}

function setup() {
    const publicKv = new SlowKV();
    const sharedKv = new SlowKV();
    const storeKvs = new Map<string, SlowKV>();
    const routing = new RoutingAdapter(publicKv, new EncryptionLayer(sharedKv, { privateKey: ROOT, enabled: true }));
    const privacy = new PrivacyManager(routing);
    routing.setPrivacyManager(privacy);
    routing.setStorePool(new StoreAdapterPool((addr) => {
        const kv = new SlowKV();
        storeKvs.set(addr.toLowerCase(), kv);
        return new EncryptionLayer(kv, { privateKey: deriveStoreRootKey(ROOT, addr), enabled: true });
    }));
    const registry = new PrivateStoreRegistry(publicKv, fakeChain, '0x726E783bf9bB351F9DAdDBDAE300D6680A27Bf32', WRITER);
    return { publicKv, sharedKv, storeKvs, routing, privacy, registry, store: new DocumentStore(routing) };
}

describe('moving a collection pauses its writes', () => {
    it('refuses writes to a collection while it is being moved (retryable)', async () => {
        const { store, privacy, routing, sharedKv } = setup();
        await privacy.setCollectionPrivacy('busy', 'private', ALICE);
        await store.insert('busy', [{ n: 1 }]);
        let release!: () => void;
        sharedKv.hold = new Promise((r) => { release = r; });           // the move's deletes wait here
        const move = store.withCollectionMove('busy', () => routing.migrateCollection('busy', 'public', async () => { await privacy.setCollectionPrivacy('busy', 'public', ALICE); }));
        await vi.waitFor(() => expect(routing.isMigrating('busy')).toBe(true));
        await expect(store.insert('busy', [{ n: 2 }])).rejects.toBeInstanceOf(CollectionBusyError);
        sharedKv.hold = undefined;
        release();
        await move;
        await store.insert('busy', [{ n: 3 }]);                           // writes resume afterwards
        expect((await store.find('busy', {})).cursor.firstBatch).toHaveLength(2);
    });

    it('waits for a write already in flight, so it lands in the new location instead of being lost', async () => {
        const { store, privacy, routing, publicKv } = setup();
        await privacy.claimIfUnowned('race', ALICE);
        await store.insert('race', [{ n: 1 }]);
        let release!: () => void;
        publicKv.hold = new Promise((r) => { release = r; });            // the next public write stalls mid-flight
        const lateWrite = store.insert('race', [{ n: 2 }]);
        await new Promise((r) => setTimeout(r, 20));
        const move = store.withCollectionMove('race', () => routing.migrateCollection('race', 'shared', async () => { await privacy.setCollectionPrivacy('race', 'private', ALICE); }));
        await new Promise((r) => setTimeout(r, 50));
        publicKv.hold = undefined;
        release();
        await lateWrite;
        await move;
        expect((await store.find('race', {})).cursor.firstBatch.map((d) => d.n).sort()).toEqual([1, 2]);
    });

    it('copies in batches, not one transaction per key', async () => {
        const { store, privacy, routing, storeKvs } = setup();
        await privacy.setCollectionPrivacy('bulk', 'private', ALICE);
        await store.insert('bulk', Array.from({ length: 60 }, (_, i) => ({ i })));   // 120 keys with the _id index
        await routing.migrateCollection('bulk', { store: STORE_A }, () => privacy.setStoreAddress('bulk', STORE_A));
        expect(storeKvs.get(STORE_A.toLowerCase())!.batches).toBe(3);                    // ceil(120 / 50)
    });
});

describe('privacy switch: estimate, confirm, cap, destination', () => {
    let app: FastifyInstance;
    let ctx: ReturnType<typeof setup>;
    const as = { 'x-test-wallet-address': ALICE };
    const switchTo = (name: string, payload: object) => app.inject({ method: 'POST', url: `/api/v1/collections/${name}/privacy`, headers: as, payload });

    beforeAll(async () => {
        ctx = setup();
        app = await createHttpServer({ port: 0, host: '127.0.0.1', store: ctx.store, metrics: new MetricsCollector(),
            kvStore: Object.assign(ctx.routing, { getKeyCount: () => 0, getEstimatedSizeBytes: () => 0 }),
            privacyManager: ctx.privacy });
        await app.ready();
    });
    afterAll(() => app.close());

    it('answers 409 with an estimate until the move is confirmed, then moves the data', async () => {
        await switchTo('orders', { mode: 'public' });   // new collections are private by default (P8)
        await app.inject({ method: 'POST', url: '/api/v1/collections/orders/insertMany', headers: as, payload: { documents: [{ n: 1 }, { n: 2 }] } });
        const preview = await switchTo('orders', { mode: 'private' });
        expect(preview.statusCode).toBe(409);
        expect(preview.json()).toMatchObject({ confirmRequired: true, estimate: { documents: 2, keys: 4, historyRemainsPublic: true, destination: 'shared private store' } });
        expect(preview.json().errmsg).toMatch(/stays readable in the chain history/);
        expect((await ctx.privacy.getCollectionPrivacy(`${ALICE.toLowerCase()}.orders`))?.mode).toBe('public');   // nothing changed (in Alice's namespace)

        const done = await switchTo('orders', { mode: 'private', confirm: true });
        expect(done.json()).toMatchObject({ ok: 1, mode: 'private', migrated: 4 });
    });

    it('needs no confirm for an empty collection', async () => {
        expect((await switchTo('empty_new', { mode: 'private' })).json()).toMatchObject({ ok: 1, mode: 'private' });
    });

    it('refuses collections too large to move in one request', async () => {
        const huge = `${ALICE.toLowerCase()}.huge`;   // in Alice's namespace
        await ctx.store.insert(huge, Array.from({ length: 1001 }, (_, i) => ({ i })));
        await ctx.privacy.claimIfUnowned(huge, ALICE);
        const res = await switchTo('huge', { mode: 'private', confirm: true });
        expect(res.statusCode).toBe(413);
        expect(res.json().estimate.keys).toBe(2002);
    });
});

describe("moving a wallet's private data into its newly linked store", () => {
    it('moves shared-private collections, leaves public ones, reports progress, and can resume', async () => {
        const { store, privacy, routing, registry, sharedKv, storeKvs } = setup();
        for (const name of ['p1', 'p2']) {
            await privacy.setCollectionPrivacy(name, 'private', ALICE);
            await store.insert(name, [{ secret: name }]);
        }
        await privacy.claimIfUnowned('pub', ALICE);
        await store.insert('pub', [{ open: true }]);

        await registry.link(ALICE, STORE_A);
        const migrations = new StoreMigrations(routing, privacy, registry, store, 1);
        await migrations.start(ALICE);

        expect(migrations.status(ALICE)).toMatchObject({ state: 'done', total: 2, moved: 2, failed: [], store: STORE_A });
        expect((await privacy.getCollectionPrivacy('p1'))?.storeAddress).toBe(STORE_A);
        expect((await privacy.getCollectionPrivacy('pub'))?.storeAddress).toBeUndefined();
        expect((await sharedKv.scan({ prefix: 'doc:p', limit: 10 })).length).toBe(0);
        expect((await storeKvs.get(STORE_A.toLowerCase())!.scan({ prefix: 'doc:p', limit: 10 })).length).toBe(2);
        expect((await store.find('p2', {})).cursor.firstBatch).toEqual([expect.objectContaining({ secret: 'p2' })]);

        // A collection made private later in the shared store is picked up on resume.
        await privacy.setCollectionPrivacy('p3', 'private', ALICE);
        await store.insert('p3', [{ secret: 'p3' }]);
        await new StoreMigrations(routing, privacy, registry, store, 1).resumeAll();
        expect((await privacy.getCollectionPrivacy('p3'))?.storeAddress).toBe(STORE_A);
    });
});
