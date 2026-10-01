// The MongoDB wire protocol used to enforce nothing beyond login: any wallet
// with an API key could read private collections and write to anyone's
// collection through mongosh. It now applies the same rule as the HTTP API
// (CollectionAccess). Item 4: a wallet with several keys must say which one.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const authContract = {
    isReadable: true,
    getActiveKeys: vi.fn(),
    getVerifier: vi.fn(),
};
vi.mock('../auth/auth-contract.js', async () => {
    const actual = await vi.importActual<typeof import('../auth/auth-contract.js')>('../auth/auth-contract.js');
    return { ...actual, getAuthContract: () => authContract };
});

const { handleCommand } = await import('../wire-server.js');
const { DocumentStore } = await import('../storage/document-store.js');
const { InMemoryKVStore } = await import('../storage/kv-adapter.js');
const { PrivacyManager } = await import('../storage/privacy-manager.js');
const { CollectionClaims } = await import('../storage/collection-claims.js');
const { CollectionAccess } = await import('../storage/collection-access.js');
const { Namespaces } = await import('../storage/namespaces.js');

const ALICE = '0xa11ce00000000000000000000000000000000001';
const BOB = '0xb0b0000000000000000000000000000000000002';
const [ALICE_CONN, BOB_CONN, OPERATOR_CONN] = [1, 2, 3];
const API_KEY = 'master-key';

function setup() {
    const kv = new InMemoryKVStore();
    const store = new DocumentStore(kv);
    const privacy = new PrivacyManager(kv);
    const claims = new CollectionClaims(privacy);
    const ownership = {
        owners: new Map([[ALICE_CONN, ALICE], [BOB_CONN, BOB]]),
        claim: (c: string, o: string, m?: 'public' | 'private') => claims.claim(c, o, m),
        access: new CollectionAccess(privacy, store, claims),
        namespaces: new Namespaces(store, privacy),
    };
    const authed = new Set([ALICE_CONN, BOB_CONN, OPERATOR_CONN]);
    const run = (conn: number, body: Record<string, unknown>) =>
        handleCommand(store, { $db: 'test', ...body }, [], conn, true, API_KEY, authed, ownership);
    return { store, privacy, run };
}

const denied = { ok: 0, codeName: 'Unauthorized' };

describe('MongoDB wire: collection access', () => {
    it("another wallet can neither read nor change a private collection, by any command", async () => {
        const { run } = setup();
        expect(await run(ALICE_CONN, { insert: 'a_private', documents: [{ secret: 1, tag: 'x' }] })).toMatchObject({ ok: 1 });
        await run(BOB_CONN, { insert: 'b_own', documents: [{ k: 1 }] });

        // Alice's collection, by its qualified name or with her address as the database.
        const A = `${ALICE}.a_private`;
        for (const body of [
            { find: A, filter: {} },
            { $db: ALICE, find: 'a_private', filter: {} },
            { count: A },
            { distinct: A, key: 'tag' },
            { aggregate: A, pipeline: [], cursor: {} },
            // reading it indirectly, from Bob's own collection
            { aggregate: 'b_own', pipeline: [{ $lookup: { from: A, localField: 'k', foreignField: 'secret', as: 'leak' } }], cursor: {} },
            { insert: A, documents: [{ x: 1 }] },
            { update: A, updates: [{ q: {}, u: { $set: { secret: 0 } } }] },
            { delete: A, deletes: [{ q: {}, limit: 0 }] },
            { $db: ALICE, drop: 'a_private' },
            { createIndexes: A, indexes: [{ key: { tag: 1 }, name: 'tag_1' }] },
        ]) {
            expect(await run(BOB_CONN, body), JSON.stringify(body)).toMatchObject(denied);
        }
        expect((await run(ALICE_CONN, { find: 'a_private', filter: {} }) as any).cursor.firstBatch).toHaveLength(1);
    });

    it('listCollections only shows what the connection may read', async () => {
        const { run } = setup();
        await run(ALICE_CONN, { insert: 'a_private', documents: [{ s: 1 }] });
        const names = async (conn: number) => ((await run(conn, { listCollections: 1 }) as any).cursor.firstBatch as { name: string }[]).map((c) => c.name);
        expect(await names(ALICE_CONN)).toContain('a_private');
        expect(await names(BOB_CONN)).not.toContain(`${ALICE}.a_private`);
        expect(await names(BOB_CONN)).not.toContain('a_private');
    });

    it('a public collection is readable by others but writable only by its owner', async () => {
        const { run } = setup();
        await run(ALICE_CONN, { create: 'a_public', plugportMode: 'public' });
        await run(ALICE_CONN, { insert: 'a_public', documents: [{ n: 1 }] });
        expect((await run(BOB_CONN, { find: `${ALICE}.a_public`, filter: {} }) as any).cursor.firstBatch).toHaveLength(1);
        expect(await run(BOB_CONN, { insert: `${ALICE}.a_public`, documents: [{ n: 2 }] })).toMatchObject(denied);
        // Bob lists it under its qualified name; Alice under her own.
        const names = async (conn: number) => ((await run(conn, { listCollections: 1 }) as any).cursor.firstBatch as { name: string }[]).map((c) => c.name);
        expect(await names(BOB_CONN)).toContain(`${ALICE}.a_public`);
        expect(await names(ALICE_CONN)).toContain('a_public');
    });

    it('the operator (master key, no wallet) manages non-private collections but cannot read private ones', async () => {
        const { run, store } = setup();
        await store.insert('legacy_demo', [{ seeded: true }]);
        expect(await run(OPERATOR_CONN, { insert: 'legacy_demo', documents: [{ more: true }] })).toMatchObject({ ok: 1 });
        // A wallet writing that name writes its own collection; the shared one is unchanged.
        expect(await run(BOB_CONN, { insert: 'legacy_demo', documents: [{ x: 1 }] })).toMatchObject({ ok: 1 });
        expect((await store.find('legacy_demo', {})).cursor.firstBatch).toHaveLength(2);
        await run(ALICE_CONN, { insert: 'a_private', documents: [{ s: 1 }] });
        expect(await run(OPERATOR_CONN, { find: `${ALICE}.a_private`, filter: {} })).toMatchObject(denied);
    });
});

describe('MongoDB wire login with several keys (item 4)', () => {
    const saslStart = (user: string) => handleCommand(
        new DocumentStore(new InMemoryKVStore()),
        { $db: 'admin', saslStart: 1, mechanism: 'SCRAM-SHA-256', payload: Buffer.from(`n,,n=${user},r=clientnonce`) },
        [], 9, false, API_KEY, new Set(),
    );
    beforeEach(() => {
        authContract.getVerifier.mockResolvedValue({ active: true, salt: '0x' + '11'.repeat(16), storedKey: '0x' + '22'.repeat(32), serverKey: '0x' + '33'.repeat(32) });
    });

    it('asks which key instead of silently using the first one', async () => {
        authContract.getActiveKeys.mockResolvedValue([{ keyIndex: 0 }, { keyIndex: 2 }, { keyIndex: 5 }]);
        const res = await saslStart(ALICE) as { ok: number; errmsg: string };
        expect(res.ok).toBe(0);
        expect(res.errmsg).toContain('3 active API keys (indexes 0, 2, 5)');
        expect(res.errmsg).toContain(`${ALICE}:<keyIndex>`);
        expect(authContract.getVerifier).not.toHaveBeenCalledWith(ALICE, 0);
    });

    it('still logs in with the only key, or the one named with :N', async () => {
        authContract.getActiveKeys.mockResolvedValue([{ keyIndex: 4 }]);
        expect(await saslStart(ALICE)).toMatchObject({ ok: 1, done: false });
        expect(authContract.getVerifier).toHaveBeenLastCalledWith(ALICE, 4);
        expect(await saslStart(`${ALICE}:2`)).toMatchObject({ ok: 1, done: false });
        expect(authContract.getVerifier).toHaveBeenLastCalledWith(ALICE, 2);
    });
});
