// P9: a private collection's metadata — its name, document count, index fields,
// owner and access list — must not be readable on the public contract. The tests
// read the raw public store, as anyone on the chain could.

import { describe, it, expect } from 'vitest';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { RoutingAdapter } from '../storage/routing-adapter.js';
import { EncryptionLayer } from '../storage/encryption-layer.js';
import { PrivacyManager } from '../storage/privacy-manager.js';
import { createMetadataCipher } from '../storage/metadata-cipher.js';
import { MetricsCollector } from '../metrics.js';
import { createHttpServer } from '../http-server.js';

const ROOT = '7ca9aab926f23abfef41acc9bbae4c81e22c8cb52b7abd78da43533dfc3e3da6';
const ALICE = '0xa11ce00000000000000000000000000000000001';
const BOB = '0xb0b0000000000000000000000000000000000002';
const NAME = 'payroll_records';

function setup({ cipher = true } = {}) {
    const publicKv = new InMemoryKVStore();
    const routing = new RoutingAdapter(publicKv, new EncryptionLayer(new InMemoryKVStore(), { privateKey: ROOT, enabled: true }));
    const metaCipher = createMetadataCipher(ROOT);
    const privacy = new PrivacyManager(routing, { cipher: cipher ? metaCipher : undefined });
    routing.setPrivacyManager(privacy);
    if (cipher) routing.setMetadataCipher(metaCipher);
    const store = new DocumentStore(routing);
    const publicDump = async () => (await publicKv.scan({ prefix: '', limit: 10000 }))
        .map((e) => `${e.key} => ${Buffer.from(e.value).toString('latin1')}`).join('\n');
    return { publicKv, routing, privacy, store, publicDump, metaCipher };
}

async function privateCollection(ctx: ReturnType<typeof setup>) {
    await ctx.privacy.claimIfUnowned(NAME, ALICE, { mode: 'private' });
    await ctx.privacy.grantAccess(NAME, BOB, 1, ALICE);
    await ctx.store.insert(NAME, [{ salary: 1, employee: 'x' }, { salary: 2, employee: 'y' }]);
    await ctx.store.createIndex(NAME, 'employee');
}

describe('sealed metadata of private collections', () => {
    it('leaves nothing readable on the public store, while the server still lists it correctly', async () => {
        const ctx = setup();
        await privateCollection(ctx);
        const dump = await ctx.publicDump();
        expect(dump).not.toContain(NAME);
        expect(dump).not.toContain(ALICE.slice(2));          // owner
        expect(dump).not.toContain(BOB.slice(2));            // granted wallet
        expect(dump).not.toContain('employee');              // index field
        expect(dump).not.toContain('"documentCount"');
        expect(dump).toMatch(/meta:pcollection:[0-9a-f]{32}/);
        expect(dump).toMatch(/meta:pprivacy:[0-9a-f]{32}/);

        const listed = await ctx.store.listCollections();
        expect(listed).toEqual([expect.objectContaining({ name: NAME, documentCount: 2 })]);
        expect(listed[0].indexes.map((i) => i.field)).toContain('employee');
        expect((await ctx.privacy.getCollectionPrivacy(NAME))?.accessRoles).toEqual({ [BOB]: 1 });
        expect(await ctx.privacy.listOwnedCollections(ALICE)).toEqual([NAME]);
        expect((await ctx.store.find(NAME, { employee: 'y' })).cursor.firstBatch).toHaveLength(1);
    });

    it('turns metadata plain when switched to public, and seals it again when switched back', async () => {
        const ctx = setup();
        await privateCollection(ctx);
        await ctx.routing.migrateCollection(NAME, 'public', async () => { await ctx.privacy.setCollectionPrivacy(NAME, 'public', ALICE); });
        let dump = await ctx.publicDump();
        expect(dump).toContain(`meta:collection:${NAME}`);
        expect(dump).toContain(`meta:privacy:${NAME}`);
        expect(dump).not.toMatch(/meta:pcollection:|meta:pprivacy:/);
        expect((await ctx.store.listCollections())[0]).toMatchObject({ name: NAME, documentCount: 2 });

        await ctx.routing.migrateCollection(NAME, 'shared', async () => { await ctx.privacy.setCollectionPrivacy(NAME, 'private', ALICE); });
        dump = await ctx.publicDump();
        expect(dump).not.toContain(NAME);
        expect((await ctx.store.listCollections())[0]).toMatchObject({ name: NAME, documentCount: 2 });
    });

    it('reads a private collection whose metadata predates sealing, and seals it on the next write', async () => {
        const legacy = setup({ cipher: false });
        await privateCollection(legacy);
        expect(await legacy.publicDump()).toContain(`meta:collection:${NAME}`);

        // Same data, now served by a server with the cipher configured.
        const routing = new RoutingAdapter(legacy.publicKv, (legacy.routing as any).privateAdapter);
        const privacy = new PrivacyManager(routing, { cipher: legacy.metaCipher });
        routing.setPrivacyManager(privacy);
        routing.setMetadataCipher(legacy.metaCipher);
        const store = new DocumentStore(routing);
        expect((await store.listCollections())[0]).toMatchObject({ name: NAME, documentCount: 2 });
        expect((await privacy.getCollectionPrivacy(NAME))?.ownerAddress).toBe(ALICE);

        await store.insert(NAME, [{ salary: 3, employee: 'z' }]);
        await privacy.grantAccess(NAME, BOB, 2, ALICE);
        const dump = (await legacy.publicKv.scan({ prefix: '', limit: 10000 })).map((e) => e.key).join('\n');
        expect(dump).not.toContain(NAME);
        expect((await store.listCollections())[0]).toMatchObject({ name: NAME, documentCount: 3 });
    });

    it('shows a private collection, with its count, to its owner only', async () => {
        const ctx = setup();
        await privateCollection(ctx);
        const app = await createHttpServer({ port: 0, host: '127.0.0.1', store: ctx.store, metrics: new MetricsCollector(),
            kvStore: Object.assign(ctx.routing, { getKeyCount: () => 0, getEstimatedSizeBytes: () => 0 }), privacyManager: ctx.privacy });
        await app.ready();
        const list = async (wallet: string) => (await app.inject({ method: 'GET', url: '/api/v1/collections', headers: { 'x-test-wallet-address': wallet } })).json().collections;
        expect(await list(ALICE)).toEqual([expect.objectContaining({ name: NAME, documentCount: 2, mode: 'private' })]);
        expect(await list('0xc0ffee0000000000000000000000000000000003')).toEqual([]);
        await app.close();
    });
});
