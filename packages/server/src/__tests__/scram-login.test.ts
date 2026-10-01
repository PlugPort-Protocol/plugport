// End-to-end SCRAM-SHA-256 logins, with a real client computing the proof per
// RFC 5802 / 7677. MongoDB and PostgreSQL share the server side (auth/scram.ts):
// a wallet username uses that key's on-chain verifier, anything else the
// server's master key. The password never crosses the wire.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifierFor, scramLogin } from './scram-client.js';

const authContract = { isReadable: true, getActiveKeys: vi.fn(), getVerifier: vi.fn() };
vi.mock('../auth/auth-contract.js', async () => {
    const actual = await vi.importActual<typeof import('../auth/auth-contract.js')>('../auth/auth-contract.js');
    return { ...actual, getAuthContract: () => authContract };
});

const { handleCommand } = await import('../wire-server.js');
const { DocumentStore } = await import('../storage/document-store.js');
const { InMemoryKVStore } = await import('../storage/kv-adapter.js');

const MASTER = 'master-api-key';
const WALLET = '0xa11ce00000000000000000000000000000000001';
const WALLET_KEY = 'pp_test_0123456789abcdef0123456789abcdef';

describe('MongoDB SCRAM-SHA-256 login', () => {
    const store = new DocumentStore(new InMemoryKVStore());
    let conn = 100;
    const login = async (user: string, password: string) => {
        const id = ++conn;
        const authed = new Set<number>();
        const ownership = { owners: new Map<number, string>() };
        let last: Record<string, unknown> = {};
        const result = await scramLogin(user, password, async (msg, step) => {
            last = await handleCommand(store, step === 1
                ? { $db: 'admin', saslStart: 1, mechanism: 'SCRAM-SHA-256', payload: Buffer.from(msg) }
                : { $db: 'admin', saslContinue: 1, conversationId: 1, payload: Buffer.from(msg) }, [], id, false, MASTER, authed, ownership);
            return last.payload ? Buffer.from(last.payload as Buffer).toString() : '';
        });
        return { ...result, authenticated: authed.has(id), wallet: ownership.owners.get(id), last };
    };

    beforeEach(() => {
        authContract.getActiveKeys.mockResolvedValue([{ keyIndex: 3 }]);
        authContract.getVerifier.mockResolvedValue(verifierFor(WALLET_KEY));
    });

    it('logs in with the master key (no wallet: the operator)', async () => {
        const r = await login('admin', MASTER);
        expect(r).toMatchObject({ authenticated: true, serverVerified: true, wallet: undefined });
    });

    it("logs in as a wallet with its API key's on-chain verifier", async () => {
        const r = await login(WALLET, WALLET_KEY);
        expect(r).toMatchObject({ authenticated: true, serverVerified: true, wallet: WALLET });
    });

    it('rejects a wrong password', async () => {
        const r = await login(WALLET, 'pp_test_wrong');
        expect(r.authenticated).toBe(false);
        expect(r.last).toMatchObject({ ok: 0, code: 18 });
    });
});
