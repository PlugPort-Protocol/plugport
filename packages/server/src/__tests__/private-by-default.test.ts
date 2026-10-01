// P8: new collections are private unless the creator asks for public, and the
// decision is made before the first write — so a new collection's documents
// never touch the public store. Checked by inspecting what each store holds.

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { RoutingAdapter } from '../storage/routing-adapter.js';
import { EncryptionLayer, deriveStoreRootKey } from '../storage/encryption-layer.js';
import { PrivacyManager } from '../storage/privacy-manager.js';
import { StoreAdapterPool } from '../storage/store-adapter-pool.js';
import { PrivateStoreRegistry } from '../storage/private-store-registry.js';
import { CollectionClaims } from '../storage/collection-claims.js';
import { handleCommand, type WireOwnership } from '../wire-server.js';
import { MetricsCollector } from '../metrics.js';
import { createHttpServer } from '../http-server.js';

const ROOT = '7ca9aab926f23abfef41acc9bbae4c81e22c8cb52b7abd78da43533dfc3e3da6';
const ALICE = '0xa11ce00000000000000000000000000000000001';
const BOB = '0xb0b0000000000000000000000000000000000002';
const WRITER = '0xd3C3353894816cDAEA9FBC3a06fA8aeB21f413EA';
const STORE_A = ethers.getAddress('0x00000000000000000000000000000000000000aa');

/** Fake chain: STORE_A belongs to Alice; `cutOff` makes it stop naming our writer. */
const chain = { cutOff: false };
const iface = new ethers.Interface(['function storeOwner(address) view returns (address)', 'function owner() view returns (address)', 'function gasStation() view returns (address)']);
const provider = { async call(tx: { data: string }) {
    const fn = iface.parseTransaction({ data: tx.data })!;
    return iface.encodeFunctionResult(fn.name, [fn.name === 'gasStation' ? (chain.cutOff ? ALICE : WRITER) : ALICE]);
} } as unknown as ethers.Provider;

function setup() {
    const publicKv = new InMemoryKVStore();
    const sharedKv = new InMemoryKVStore();
    const storeKvs = new Map<string, InMemoryKVStore>();
    const routing = new RoutingAdapter(publicKv, new EncryptionLayer(sharedKv, { privateKey: ROOT, enabled: true }));
    const privacy = new PrivacyManager(routing);
    routing.setPrivacyManager(privacy);
    routing.setStorePool(new StoreAdapterPool((addr) => {
        const kv = new InMemoryKVStore();
        storeKvs.set(addr.toLowerCase(), kv);
        return new EncryptionLayer(kv, { privateKey: deriveStoreRootKey(ROOT, addr), enabled: true });
    }));
    const registry = new PrivateStoreRegistry(publicKv, provider, '0x726E783bf9bB351F9DAdDBDAE300D6680A27Bf32', WRITER);
    const store = new DocumentStore(routing);
    const docsIn = async (kv: InMemoryKVStore | undefined, collection: string) => (kv ? await kv.scan({ prefix: `doc:${collection}:`, limit: 100 }) : []).length;
    return { publicKv, sharedKv, storeKvs, routing, privacy, registry, store, claims: new CollectionClaims(privacy, registry), docsIn };
}

describe('private by default', () => {
    it('HTTP: the first write creates a private collection; its documents never touch the public store', async () => {
        const { routing, privacy, registry, store, publicKv, sharedKv, docsIn } = setup();
        const app = await createHttpServer({ port: 0, host: '127.0.0.1', store, metrics: new MetricsCollector(),
            kvStore: Object.assign(routing, { getKeyCount: () => 0, getEstimatedSizeBytes: () => 0 }), privacyManager: privacy, privateStores: registry });
        await app.ready();
        const res = await app.inject({ method: 'POST', url: '/api/v1/collections/notes/insertOne', headers: { 'x-test-wallet-address': BOB }, payload: { document: { x: 1 } } });
        expect(res.statusCode).toBe(200);
        // Physically in Bob's namespace (per-wallet namespaces).
        const notes = `${BOB.toLowerCase()}.notes`;
        expect((await privacy.getCollectionPrivacy(notes))?.mode).toBe('private');
        expect(await docsIn(sharedKv, notes)).toBe(1);
        expect(await docsIn(publicKv, notes)).toBe(0);
        await app.close();
    });

    it("puts a new collection in the owner's own store when it is active, else in the shared store", async () => {
        const { claims, privacy, registry, store, storeKvs, sharedKv, docsIn } = setup();
        await registry.link(ALICE, STORE_A);
        await claims.claim('in_my_store', ALICE);
        await store.insert('in_my_store', [{ a: 1 }]);
        expect((await privacy.getCollectionPrivacy('in_my_store'))?.storeAddress).toBe(STORE_A);
        expect(await docsIn(storeKvs.get(STORE_A.toLowerCase()), 'in_my_store')).toBe(1);

        chain.cutOff = true;   // Alice cut PlugPort off: new data can't go to her store
        try {
            await claims.claim('after_cutoff', ALICE);
            await store.insert('after_cutoff', [{ a: 1 }]);
            expect((await privacy.getCollectionPrivacy('after_cutoff'))?.storeAddress).toBeUndefined();
            expect(await docsIn(sharedKv, 'after_cutoff')).toBe(1);
        } finally {
            chain.cutOff = false;
        }
    });

    it('public only when asked for', async () => {
        const { claims, privacy } = setup();
        await claims.claim('open_data', ALICE, 'public');
        expect((await privacy.getCollectionPrivacy('open_data'))?.mode).toBe('public');
        expect(await claims.claim('open_data', BOB)).toBe(false); // already owned
    });

    it('mongosh: insert into a new collection is private; createCollection with plugportMode "public" opts out', async () => {
        const { claims, privacy, store, publicKv, sharedKv, docsIn } = setup();
        const ownership: WireOwnership = { owners: new Map([[7, ALICE]]), claim: (c, o, m) => claims.claim(c, o, m) };
        const run = (body: Record<string, unknown>) => handleCommand(store, { $db: 'test', ...body }, [], 7, true, undefined, new Set([7]), ownership);

        await run({ insert: 'wire_private', documents: [{ s: 1 }] });
        expect((await privacy.getCollectionPrivacy('wire_private'))?.mode).toBe('private');
        expect(await docsIn(sharedKv, 'wire_private')).toBe(1);
        expect(await docsIn(publicKv, 'wire_private')).toBe(0);

        await run({ create: 'wire_public', plugportMode: 'public' });
        await run({ insert: 'wire_public', documents: [{ s: 1 }] });
        expect((await privacy.getCollectionPrivacy('wire_public'))?.mode).toBe('public');
        expect(await docsIn(publicKv, 'wire_public')).toBe(1);
    });
});

describe('moving private collections from before namespaces (item 2)', () => {
    it('keeps their data private, in the same store, under the new name', async () => {
        const { privacy, store, publicKv, sharedKv, storeKvs, docsIn } = setup();
        const { Namespaces } = await import('../storage/namespaces.js');
        const { NamespaceMigration } = await import('../storage/namespace-migration.js');
        // Alice's private collection lives in her own store; Bob's in the shared private store.
        await privacy.claimIfUnowned('vault', ALICE, { mode: 'private', storeAddress: STORE_A });
        await store.insert('vault', [{ secret: 1 }, { secret: 2 }]);
        await privacy.claimIfUnowned('ledger', BOB, { mode: 'private' });
        await store.insert('ledger', [{ owed: 5 }]);

        const namespaces = new Namespaces(store, privacy);
        await namespaces.load();
        expect(await new NamespaceMigration(store, privacy, namespaces, 1).run()).toMatchObject({ state: 'done', moved: 2 });

        const vault = `${ALICE}.vault`;
        const ledger = `${BOB}.ledger`;
        const aliceStore = storeKvs.get(STORE_A.toLowerCase());
        expect(await docsIn(aliceStore, vault)).toBe(2);
        expect(await docsIn(aliceStore, 'vault')).toBe(0);
        expect(await docsIn(sharedKv, ledger)).toBe(1);
        expect(await docsIn(sharedKv, 'ledger')).toBe(0);
        for (const name of [vault, ledger, 'vault', 'ledger']) expect(await docsIn(publicKv, name)).toBe(0);
        expect(await privacy.getCollectionPrivacy(vault)).toMatchObject({ mode: 'private', ownerAddress: ALICE, storeAddress: STORE_A });
        expect((await store.find(vault, {})).cursor.firstBatch.map((d) => d.secret).sort()).toEqual([1, 2]);
        expect((await store.find(ledger, {})).cursor.firstBatch).toEqual([expect.objectContaining({ owed: 5 })]);
    });
});
