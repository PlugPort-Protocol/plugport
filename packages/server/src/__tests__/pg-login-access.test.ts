// PostgreSQL logins are per-customer now: SCRAM-SHA-256 (it replaced the
// cleartext password prompt) with a wallet's on-chain API-key verifier, or the
// master key for the operator. Every translated statement then goes through
// the same collection access rule as HTTP and MongoDB.

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { verifierFor } from './scram-client.js';
import { PgTestClient } from './pg-client.js';

const authContract = { isReadable: true, getActiveKeys: vi.fn(), getVerifier: vi.fn() };
vi.mock('../auth/auth-contract.js', async () => {
    const actual = await vi.importActual<typeof import('../auth/auth-contract.js')>('../auth/auth-contract.js');
    return { ...actual, getAuthContract: () => authContract };
});

const { PGServer } = await import('../protocols/pg-server.js');
const { DocumentStore } = await import('../storage/document-store.js');
const { InMemoryKVStore } = await import('../storage/kv-adapter.js');
const { PrivacyManager } = await import('../storage/privacy-manager.js');
const { CollectionClaims } = await import('../storage/collection-claims.js');
const { CollectionAccess } = await import('../storage/collection-access.js');
const { Namespaces } = await import('../storage/namespaces.js');

const MASTER = 'master-api-key';
const ALICE = '0xa11ce00000000000000000000000000000000001';
const BOB = '0xb0b0000000000000000000000000000000000002';
const KEYS: Record<string, string> = { [ALICE]: 'pp_test_alice_key_0123456789abcdef', [BOB]: 'pp_test_bob_key_0123456789abcdef00' };
const PORT = 46000 + Math.floor(Math.random() * 1000);

let server: InstanceType<typeof PGServer>;
let store: InstanceType<typeof DocumentStore>;
const clients: InstanceType<typeof PgTestClient>[] = [];
const connect = async (user: string, password: string) => {
    const c = new PgTestClient(PORT);
    clients.push(c);
    const err = await c.login(user, password);
    if (err) throw new Error(err);
    return c;
};

beforeAll(async () => {
    const kv = new InMemoryKVStore();
    store = new DocumentStore(kv);
    const privacy = new PrivacyManager(kv);
    const claims = new CollectionClaims(privacy);
    server = new PGServer({ store, port: PORT, host: '127.0.0.1', apiKey: MASTER, access: new CollectionAccess(privacy, store, claims), namespaces: new Namespaces(store, privacy) });
    await server.start();
});
afterAll(async () => {
    clients.forEach((c) => c.end());
    await server.stop();
});
beforeEach(() => {
    authContract.getActiveKeys.mockResolvedValue([{ keyIndex: 0 }]);
    const verifiers = Object.fromEntries(Object.entries(KEYS).map(([w, k]) => [w, verifierFor(k)]));
    authContract.getVerifier.mockImplementation(async (wallet: string) => verifiers[wallet.toLowerCase()]);
});

describe('PostgreSQL SCRAM-SHA-256 login', () => {
    it('logs in with the master key and as a wallet with its API key', async () => {
        await expect(connect('admin', MASTER)).resolves.toBeDefined();
        await expect(connect(ALICE, KEYS[ALICE])).resolves.toBeDefined();
        await expect(connect(`${ALICE}:0`, KEYS[ALICE])).resolves.toBeDefined();
    });

    it('rejects a wrong key, and another wallet\'s key', async () => {
        await expect(connect(ALICE, 'pp_test_wrong')).rejects.toThrow('password authentication failed');
        await expect(connect(ALICE, KEYS[BOB])).rejects.toThrow('password authentication failed');
    });

    it('asks which key when the wallet has several', async () => {
        authContract.getActiveKeys.mockResolvedValue([{ keyIndex: 0 }, { keyIndex: 2 }]);
        await expect(connect(ALICE, KEYS[ALICE])).rejects.toThrow(`Log in as ${ALICE}:<keyIndex>`);
    });

    it('refuses queries before login', async () => {
        const c = new PgTestClient(PORT);
        clients.push(c);
        c.send('Q', Buffer.from('SELECT * FROM anything\0'));
        await new Promise((r) => setTimeout(r, 100));
        expect(c.closed || (await Promise.race([c.next().then((m) => m.type), new Promise((r) => setTimeout(() => r('none'), 200))])) !== 'D').toBe(true);
    });
});

describe('PostgreSQL: collection access', () => {
    it("another wallet can neither read nor change a private table, by any statement", async () => {
        const alice = await connect(ALICE, KEYS[ALICE]);
        const bob = await connect(BOB, KEYS[BOB]);
        expect(await alice.query("INSERT INTO a_private (secret, tag) VALUES (1, 'x')")).toHaveProperty('rows');
        expect(await bob.query("INSERT INTO b_own (k) VALUES (1)")).toHaveProperty('rows');

        // Alice's table, by its qualified name.
        const A = `"${ALICE}".a_private`;
        for (const sql of [
            `SELECT * FROM ${A}`,
            `SELECT COUNT(*) FROM ${A}`,
            `SELECT * FROM b_own JOIN ${A} a ON b_own.k = a.secret`,
            `INSERT INTO ${A} (x) VALUES (1)`,
            `UPDATE ${A} SET secret = 0`,
            `DELETE FROM ${A}`,
            `DROP TABLE ${A}`,
        ]) {
            expect(await bob.query(sql), sql).toMatchObject({ error: expect.stringContaining('Access denied') });
        }
        expect(await alice.query('SELECT secret FROM a_private')).toEqual({ rows: ['1'] });
    });

    it('the table list only shows what the connection may read', async () => {
        const alice = await connect(ALICE, KEYS[ALICE]);
        const bob = await connect(BOB, KEYS[BOB]);
        await alice.query("INSERT INTO a_hidden (s) VALUES (1)");
        const list = 'SHOW TABLES';
        expect(await alice.query(list)).toMatchObject({ rows: expect.arrayContaining(['a_hidden']) });
        expect((await bob.query(list) as { rows: string[] }).rows).not.toContain(`${ALICE}.a_hidden`);
    });

    it('the operator manages unowned tables; wallets cannot write them', async () => {
        await store.insert('legacy_demo', [{ seeded: true }]);
        const op = await connect('admin', MASTER);
        const bob = await connect(BOB, KEYS[BOB]);
        expect(await op.query("INSERT INTO legacy_demo (more) VALUES (1)")).toHaveProperty('rows');
        // Bob reads the shared table under its plain name, but can't change it: his write makes his own.
        expect(await bob.query('SELECT * FROM legacy_demo')).toMatchObject({ rows: [expect.any(String), expect.any(String)] });
        expect(await bob.query("INSERT INTO legacy_demo (x) VALUES (1)")).toHaveProperty('rows');
        expect((await store.find('legacy_demo', {})).cursor.firstBatch).toHaveLength(2);
    });
});
