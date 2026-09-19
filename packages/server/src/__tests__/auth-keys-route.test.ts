// HTTP behaviour around on-chain keys:
//  - GET /api/v1/auth/keys/:address must say "temporarily unavailable" (503) when
//    the chain read fails, not answer 200 with an empty list the dashboard shows
//    as "you have no keys".
//  - GET /api/v1/user/:address/metrics must count BOTH key systems (legacy
//    off-chain + on-chain). That on-chain count was once lost in a stray
//    checkout and nothing noticed, because nothing tested it.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const contract = {
    isReadable: true,
    isConfigured: false,
    getActiveKeys: vi.fn(),
    getKeyState: vi.fn(),
    getOwner: vi.fn(async () => null),
};

vi.mock('../auth/auth-contract.js', async () => {
    const actual = await vi.importActual<typeof import('../auth/auth-contract.js')>('../auth/auth-contract.js');
    return { ...actual, getAuthContract: () => contract };
});

const { createHttpServer } = await import('../http-server.js');
const { AuthReadError } = await import('../auth/auth-contract.js');
const { DocumentStore } = await import('../storage/document-store.js');
const { InMemoryKVStore } = await import('../storage/kv-adapter.js');
const { MetricsCollector } = await import('../metrics.js');

const ME = '0xb2ac1908cfb52debcca860ebcf538770e67df2b5';
const key = (i: number) => ({ keyIndex: i, commitment: `0xc${i}`, salt: '0xs', storedKey: '0xa', serverKey: '0xb', active: true, createdAt: 0 });

describe('on-chain key routes', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        const kvStore = new InMemoryKVStore();
        app = await createHttpServer({
            port: 0, host: '127.0.0.1',
            store: new DocumentStore(kvStore), metrics: new MetricsCollector(), kvStore,
            protocolManager: { getActiveProtocols: () => [], enableProtocol: async () => {}, disableProtocol: async () => {} },
        });
        await app.ready();
    });
    afterAll(async () => { await app.close(); });
    beforeEach(() => {
        contract.getActiveKeys.mockReset();
        contract.getKeyState.mockReset();
    });

    describe('GET /api/v1/auth/keys/:address', () => {
        it('returns the keys and nonce when the chain answers', async () => {
            contract.getKeyState.mockResolvedValue({ activeKeys: [key(0), key(1)], nonce: 25 });
            const res = await app.inject({ method: 'GET', url: `/api/v1/auth/keys/${ME}` });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toMatchObject({ ok: 1, nonce: 25 });
            expect(res.json().activeKeys).toHaveLength(2);
        });

        it('answers 503 — not 200 with an empty list or nonce 0 — when the chain read fails', async () => {
            contract.getKeyState.mockRejectedValue(new AuthReadError('your keys'));
            const res = await app.inject({ method: 'GET', url: `/api/v1/auth/keys/${ME}` });
            expect(res.statusCode).toBe(503);
            expect(res.json()).toMatchObject({ ok: 0, retryable: true });
            expect(res.json().activeKeys).toBeUndefined();
            expect(res.json().nonce).toBeUndefined();
            expect(res.json().errmsg).toMatch(/nothing has been lost/i);
        });

        it('a real empty result is still a 200 with an empty list', async () => {
            contract.getKeyState.mockResolvedValue({ activeKeys: [], nonce: 0 });
            const res = await app.inject({ method: 'GET', url: `/api/v1/auth/keys/${ME}` });
            expect(res.statusCode).toBe(200);
            expect(res.json().activeKeys).toEqual([]);
        });
    });

    describe('GET /api/v1/user/:address/metrics', () => {
        const metrics = () => app.inject({
            method: 'GET',
            url: `/api/v1/user/${ME}/metrics`,
            headers: { 'x-test-wallet-address': ME },
        });

        it('counts on-chain keys (the Overview "API keys" stat)', async () => {
            contract.getActiveKeys.mockResolvedValue([key(0), key(1), key(2)]);
            const res = await metrics();
            expect(res.statusCode).toBe(200);
            expect(res.json().apiKeys).toBe(3);
            expect(res.json().apiKeysComplete).toBe(true);
        });

        it('adds legacy off-chain keys to the on-chain count', async () => {
            contract.getActiveKeys.mockResolvedValue([key(0), key(1)]);
            const gen = await app.inject({
                method: 'POST', url: '/api/v1/keys/generate',
                headers: { 'x-test-wallet-address': ME },
                payload: { label: 'legacy one' },
            });
            expect(gen.statusCode).toBe(200);
            expect((await metrics()).json().apiKeys).toBe(3); // 1 legacy + 2 on-chain
        });

        it('falls back to the legacy count and flags it as partial when the chain read fails', async () => {
            contract.getActiveKeys.mockRejectedValue(new AuthReadError('your keys'));
            const res = await metrics();
            expect(res.statusCode).toBe(200); // the metrics page still loads
            expect(res.json().apiKeysComplete).toBe(false);
            expect(typeof res.json().apiKeys).toBe('number');
        });
    });
});
