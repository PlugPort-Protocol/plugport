// A document written over any protocol must show up under the writing wallet's
// "My Collections". The dashboard lists collections whose privacy record names the
// wallet as owner, so a write has to leave such a record behind. Before this, a
// wallet could insert through mongosh and the dashboard would show nothing.

import { describe, it, expect, vi } from 'vitest';
import { handleCommand, type WireOwnership } from '../wire-server.js';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { PrivacyManager } from '../storage/privacy-manager.js';

const ME = '0xb2ac1908cfb52debcca860ebcf538770e67df2b5';
const OTHER = '0x00000000000000000000000000000000000000aa';

function setup(connectionOwner?: string) {
    const kv = new InMemoryKVStore();
    const store = new DocumentStore(kv);
    const privacy = new PrivacyManager(kv);
    const ownership: WireOwnership = { owners: new Map(), claim: (c, o) => privacy.claimIfUnowned(c, o) };
    if (connectionOwner) ownership.owners.set(1, connectionOwner);
    const run = (body: Record<string, unknown>) =>
        handleCommand(store, { $db: 'test', ...body }, [], 1, true, undefined, new Set(), ownership);
    return { store, privacy, ownership, run };
}

describe('PrivacyManager.claimIfUnowned', () => {
    it('records the first writer as owner of an unowned collection', async () => {
        const { privacy } = setup();
        expect(await privacy.claimIfUnowned('orders', ME)).toBe(true);
        expect((await privacy.getCollectionPrivacy('orders'))?.ownerAddress).toBe(ME);
    });

    it('never takes a collection that already has an owner', async () => {
        const { privacy } = setup();
        await privacy.claimIfUnowned('orders', ME);
        expect(await privacy.claimIfUnowned('orders', OTHER)).toBe(false);
        expect((await privacy.getCollectionPrivacy('orders'))?.ownerAddress).toBe(ME);
    });

    it('does not override a private collection\'s settings', async () => {
        const { privacy } = setup();
        await privacy.setCollectionPrivacy('secret', 'private', ME);
        await privacy.claimIfUnowned('secret', OTHER);
        expect(await privacy.getCollectionPrivacy('secret')).toMatchObject({ mode: 'private', ownerAddress: ME });
    });

    it('concurrent first writes share one claim and settle on one owner', async () => {
        const { privacy } = setup();
        const spy = vi.spyOn(privacy, 'setCollectionPrivacy');
        await Promise.all([privacy.claimIfUnowned('race', ME), privacy.claimIfUnowned('race', OTHER)]);
        expect(spy).toHaveBeenCalledTimes(1);
        expect((await privacy.getCollectionPrivacy('race'))?.ownerAddress).toBe(ME);
    });
});

describe('wire writes record the authenticated wallet as owner', () => {
    it('insert claims the collection', async () => {
        const { run, privacy } = setup(ME);
        await run({ insert: 'mongosh_docs', documents: [{ a: 1 }] });
        expect((await privacy.getCollectionPrivacy('mongosh_docs'))?.ownerAddress).toBe(ME);
    });

    it('create claims the collection', async () => {
        const { run, privacy } = setup(ME);
        await run({ create: 'fresh' });
        expect((await privacy.getCollectionPrivacy('fresh'))?.ownerAddress).toBe(ME);
    });

    it('a connection without a proven wallet claims nothing (legacy key / no auth)', async () => {
        const { run, privacy } = setup(undefined);
        await run({ insert: 'anon_docs', documents: [{ a: 1 }] });
        expect(await privacy.getCollectionPrivacy('anon_docs')).toBeNull();
    });

    it('writing to someone else\'s collection does not steal it', async () => {
        const { run, privacy } = setup(OTHER);
        await privacy.claimIfUnowned('theirs', ME);
        await run({ insert: 'theirs', documents: [{ a: 1 }] });
        expect((await privacy.getCollectionPrivacy('theirs'))?.ownerAddress).toBe(ME);
    });

    it('a failing ownership record does not fail the write', async () => {
        const { store, ownership } = setup(ME);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        ownership.claim = async () => { throw new Error('kv down'); };
        const res = await handleCommand(store, { $db: 'test', insert: 'x', documents: [{ a: 1 }] }, [], 1, true, undefined, new Set(), ownership);
        expect(res).toMatchObject({ n: 1, ok: 1 });
    });
});
