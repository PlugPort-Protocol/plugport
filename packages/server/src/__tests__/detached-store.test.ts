// P10: a customer can cut PlugPort off from their own store. PlugPort can then
// neither write nor read it (the store's read functions are restricted too), and
// the chain adapter would have reported every document as missing. Instead,
// collections in such a store fail with an explanation, stay listed for the
// owner, and work again once access is restored.

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { RoutingAdapter, StoreDetachedError } from '../storage/routing-adapter.js';
import { EncryptionLayer, deriveStoreRootKey } from '../storage/encryption-layer.js';
import { PrivacyManager } from '../storage/privacy-manager.js';
import { StoreAdapterPool } from '../storage/store-adapter-pool.js';
import { PrivateStoreRegistry } from '../storage/private-store-registry.js';
import { MetricsCollector } from '../metrics.js';
import { createHttpServer } from '../http-server.js';

const ROOT = '7ca9aab926f23abfef41acc9bbae4c81e22c8cb52b7abd78da43533dfc3e3da6';
const ALICE = '0xa11ce00000000000000000000000000000000001';
const WRITER = '0xd3C3353894816cDAEA9FBC3a06fA8aeB21f413EA';
const STORE_A = ethers.getAddress('0x00000000000000000000000000000000000000aa');

const chain = { cutOff: false, gasStationCalls: 0 };
const iface = new ethers.Interface(['function storeOwner(address) view returns (address)', 'function owner() view returns (address)', 'function gasStation() view returns (address)']);
const provider = { async call(tx: { data: string }) {
    const fn = iface.parseTransaction({ data: tx.data })!;
    if (fn.name === 'gasStation') chain.gasStationCalls++;
    return iface.encodeFunctionResult(fn.name, [fn.name === 'gasStation' ? (chain.cutOff ? ALICE : WRITER) : ALICE]);
} } as unknown as ethers.Provider;

function setup() {
    const publicKv = new InMemoryKVStore();
    const routing = new RoutingAdapter(publicKv, new EncryptionLayer(new InMemoryKVStore(), { privateKey: ROOT, enabled: true }));
    const privacy = new PrivacyManager(routing);
    routing.setPrivacyManager(privacy);
    routing.setStorePool(new StoreAdapterPool((addr) => new EncryptionLayer(new InMemoryKVStore(), { privateKey: deriveStoreRootKey(ROOT, addr), enabled: true })));
    const registry = new PrivateStoreRegistry(publicKv, provider, '0x726E783bf9bB351F9DAdDBDAE300D6680A27Bf32', WRITER);
    // No caching here, so each test controls the store's state directly.
    routing.setStoreGuard(async () => (chain.cutOff ? { ok: false, reason: `its owner has revoked PlugPort's writer (${WRITER})` } : { ok: true }), WRITER);
    return { routing, privacy, registry, store: new DocumentStore(routing) };
}

describe('a store its owner cut PlugPort off from', () => {
    it('fails reads and writes with an explanation, and works again once access is restored', async () => {
        const { privacy, store } = setup();
        await privacy.claimIfUnowned('vault', ALICE, { mode: 'private', storeAddress: STORE_A });
        await store.insert('vault', [{ secret: 1 }]);

        chain.cutOff = true;
        try {
            const read = await store.find('vault', {}).catch((e) => e);
            expect(read).toBeInstanceOf(StoreDetachedError);
            expect(read.message).toContain(STORE_A);
            expect(read.message).toContain('Your data is still in your contract');
            expect(read.message).toContain(`transferGasStation(${WRITER})`);
            await expect(store.insert('vault', [{ secret: 2 }])).rejects.toBeInstanceOf(StoreDetachedError);
        } finally {
            chain.cutOff = false;
        }
        expect((await store.find('vault', {})).cursor.firstBatch).toHaveLength(1);
    });

    it('answers HTTP 423 with storeDetached, and keeps the collection listed for its owner', async () => {
        const { routing, privacy, registry, store } = setup();
        await privacy.claimIfUnowned('vault', ALICE, { mode: 'private', storeAddress: STORE_A });
        await store.insert('vault', [{ secret: 1 }]);
        const app = await createHttpServer({ port: 0, host: '127.0.0.1', store, metrics: new MetricsCollector(),
            kvStore: Object.assign(routing, { getKeyCount: () => 0, getEstimatedSizeBytes: () => 0 }), privacyManager: privacy, privateStores: registry });
        await app.ready();
        chain.cutOff = true;
        try {
            const res = await app.inject({ method: 'POST', url: '/api/v1/collections/vault/find', headers: { 'x-test-wallet-address': ALICE }, payload: { filter: {} } });
            expect(res.statusCode).toBe(423);
            expect(res.json()).toMatchObject({ storeDetached: true, store: STORE_A });
            const list = await app.inject({ method: 'GET', url: '/api/v1/collections', headers: { 'x-test-wallet-address': ALICE } });
            expect(list.json().collections).toEqual([expect.objectContaining({ name: 'vault', mode: 'private', storeDetached: true })]);
        } finally {
            chain.cutOff = false;
            await app.close();
        }
    });
});

describe('PrivateStoreRegistry.checkWriter', () => {
    it('asks the chain at most once per store per minute', async () => {
        const registry = new PrivateStoreRegistry(new InMemoryKVStore(), provider, '0x726E783bf9bB351F9DAdDBDAE300D6680A27Bf32', WRITER);
        chain.gasStationCalls = 0;
        for (let i = 0; i < 5; i++) expect((await registry.checkWriter(STORE_A)).ok).toBe(true);
        expect(chain.gasStationCalls).toBe(1);
    });
});
