// Per-customer private stores (option B). A store is only linked after checking
// it on-chain; before, POST /api/v1/deploy/register accepted any address. The
// chain is stood in for by a fake reader answering the three view calls.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers } from 'ethers';
import type { FastifyInstance } from 'fastify';
import { PrivateStoreRegistry } from '../storage/private-store-registry.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { DocumentStore } from '../storage/document-store.js';
import { MetricsCollector } from '../metrics.js';
import { PrivacyManager } from '../storage/privacy-manager.js';
import { createHttpServer } from '../http-server.js';

const FACTORY = '0x726E783bf9bB351F9DAdDBDAE300D6680A27Bf32';
const WRITER = '0xd3C3353894816cDAEA9FBC3a06fA8aeB21f413EA';
const ALICE = '0xa11ce00000000000000000000000000000000001';
const BOB = '0xb0b0000000000000000000000000000000000002';
const store = (n: number) => ethers.getAddress('0x' + String(n).padStart(40, '5'));

/** What the chain says: factory registry, and each store's owner and gas station. */
const chain = {
    deployedFor: new Map<string, string>(),
    owner: new Map<string, string>(),
    gasStation: new Map<string, string>(),
};
function addStore(addr: string, owner: string, gasStation = WRITER, deployedFor = owner) {
    chain.deployedFor.set(addr.toLowerCase(), deployedFor);
    chain.owner.set(addr.toLowerCase(), owner);
    chain.gasStation.set(addr.toLowerCase(), gasStation);
}

const iface = new ethers.Interface([
    'function storeOwner(address) view returns (address)',
    'function owner() view returns (address)',
    'function gasStation() view returns (address)',
]);
const fakeProvider = {
    async call(tx: { to: string; data: string }) {
        const fn = iface.parseTransaction({ data: tx.data })!;
        const to = tx.to.toLowerCase();
        const answer = fn.name === 'storeOwner'
            ? chain.deployedFor.get(String(fn.args[0]).toLowerCase()) ?? ethers.ZeroAddress
            : fn.name === 'owner' ? chain.owner.get(to)! : chain.gasStation.get(to)!;
        return iface.encodeFunctionResult(fn.name, [answer]);
    },
} as unknown as ethers.Provider;

const registry = () => new PrivateStoreRegistry(new InMemoryKVStore(), fakeProvider, FACTORY, WRITER);

describe('PrivateStoreRegistry.verify', () => {
    beforeAll(() => {
        addStore(store(1), ALICE);
        addStore(store(2), BOB);
        addStore(store(3), ALICE, ALICE);                    // Alice cut PlugPort off
        addStore(store(4), BOB, WRITER, ALICE);               // deployed for Alice, transferred to Bob
    });

    it('accepts a store our factory deployed for this wallet, naming our writer', async () => {
        expect(await registry().verify(store(1), ALICE)).toEqual({ ok: true });
    });

    it.each([
        ['an arbitrary contract', store(9), ALICE, /not deployed by the PlugPort private store factory/],
        ["someone else's store", store(2), ALICE, /deployed for a different wallet/],
        ['a store PlugPort was cut off from', store(3), ALICE, /does not authorise PlugPort's writer/],
        ['a store transferred away', store(4), ALICE, /transferred to a different owner/],
        ['an invalid address', '0x1234', ALICE, /not a valid contract address/],
    ])('rejects %s', async (_label, addr, wallet, reason) => {
        const result = await registry().verify(addr, wallet);
        expect(result.ok).toBe(false);
        expect(result.ok ? '' : result.reason).toMatch(reason);
    });
});

describe('PrivateStoreRegistry.link', () => {
    it('links one store per wallet; re-linking the same store is a no-op', async () => {
        const r = registry();
        expect(await r.storeFor(ALICE)).toBeNull();
        const first = await r.link(ALICE, store(1));
        expect(first.ok).toBe(true);
        expect((await r.storeFor(ALICE))?.address).toBe(store(1));
        expect((await r.link(ALICE, store(1))).ok).toBe(true);

        addStore(store(6), ALICE);
        const second = await r.link(ALICE, store(6));
        expect(second.ok).toBe(false);
        expect(second.ok ? '' : second.reason).toMatch(/already has a private store/);
    });

    it('does not link a store that fails verification', async () => {
        const r = registry();
        expect((await r.link(ALICE, store(2))).ok).toBe(false);
        expect(await r.storeFor(ALICE)).toBeNull();
    });
});

describe('private store HTTP endpoints', () => {
    let app: FastifyInstance;
    let docs: DocumentStore;
    const as = (w: string) => ({ 'x-test-wallet-address': w });

    beforeAll(async () => {
        addStore(store(7), ALICE);
        const kvStore = new InMemoryKVStore();
        docs = new DocumentStore(kvStore);
        app = await createHttpServer({
            port: 0, host: '127.0.0.1', store: docs, metrics: new MetricsCollector(), kvStore,
            privacyManager: new PrivacyManager(kvStore),
            privateStores: new PrivateStoreRegistry(kvStore, fakeProvider, FACTORY, WRITER),
        });
        await app.ready();
    });
    afterAll(() => app.close());

    it("tells the dashboard to name PlugPort's PrivateStore writer (not the Auth relayer)", async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/deploy/system-gas-station' });
        expect(res.json().address).toBe(WRITER);
    });

    it('registers only a verified store, then reports it active', async () => {
        const bad = await app.inject({ method: 'POST', url: '/api/v1/deploy/register', headers: as(ALICE), payload: { contractAddress: store(2), contractType: 'privateStore' } });
        expect(bad.statusCode).toBe(400);
        expect(bad.json().errmsg).toMatch(/Store rejected: this store was deployed for a different wallet/);

        const ok = await app.inject({ method: 'POST', url: '/api/v1/deploy/register', headers: as(ALICE), payload: { contractAddress: store(7), contractType: 'privateStore' } });
        expect(ok.statusCode).toBe(200);

        const status = await app.inject({ method: 'GET', url: '/api/v1/deploy/private-store', headers: as(ALICE) });
        expect(status.json()).toMatchObject({ enabled: true, status: 'active', store: { address: store(7) } });
    });

    it('reports a store as detached once the customer cuts PlugPort off', async () => {
        chain.gasStation.set(store(7).toLowerCase(), ALICE);
        const status = await app.inject({ method: 'GET', url: '/api/v1/deploy/private-store', headers: as(ALICE) });
        expect(status.json()).toMatchObject({ status: 'detached', reason: expect.stringMatching(/cut off/) });
    });

    it('does not let a wallet claim an existing unowned collection through the privacy endpoint', async () => {
        await docs.insert('legacy_demo', [{ seeded: true }]);
        const res = await app.inject({ method: 'POST', url: '/api/v1/collections/legacy_demo/privacy', headers: as(BOB), payload: { mode: 'private' } });
        expect(res.statusCode).toBe(403);
        expect(res.json().errmsg).toMatch(/no owner and is read-only/);
    });
});
