// The Monad public RPC rejects most batched and parallel requests, and ethers'
// JsonRpcProvider batches concurrent calls by default — see storage/rpc-provider.ts
// for the measurements. These tests run against a local stub server so they can
// assert what actually goes over the wire, without touching the network.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRpcProvider, RpcRateLimiter, resetRpcFailover, FAILOVER_COOLDOWN_MS } from '../storage/rpc-provider.js';

describe('createRpcProvider', () => {
    let server: http.Server;
    let url: string;
    const bodies: unknown[] = [];
    // Distinct calls: ethers de-duplicates identical in-flight requests (e.g. several
    // getBlockNumber() at once become one), which would hide batching either way.
    const addr = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}`;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => (raw += c));
            req.on('end', () => {
                const body = JSON.parse(raw);
                bodies.push(body);
                const answer = (r: { id: number; method: string }) => ({
                    jsonrpc: '2.0', id: r.id,
                    result: r.method === 'eth_chainId' ? '0x279f' : '0x10',
                });
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
            });
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('turns request batching off', () => {
        const p = createRpcProvider(url, 10143) as unknown as { _getOption(k: string): unknown; destroy(): void };
        expect(p._getOption('batchMaxCount')).toBe(1);
        p.destroy();
    });

    it('sends every call as its own request — never a JSON-RPC array', async () => {
        bodies.length = 0;
        const p = createRpcProvider(url, 10143);
        await Promise.all(Array.from({ length: 6 }, (_, i) => p.getBalance(addr(i))));
        expect(bodies.length).toBeGreaterThanOrEqual(6);
        expect(bodies.some((b) => Array.isArray(b))).toBe(false);
        p.destroy();
    });

    it('does not spend a request on chain-id detection (the network is static)', async () => {
        bodies.length = 0;
        const p = createRpcProvider(url, 10143);
        await p.getBlockNumber();
        const methods = bodies.flat().map((b) => (b as { method: string }).method);
        expect(methods).not.toContain('eth_chainId');
        p.destroy();
    });

    it('for contrast, the ethers default DOES batch concurrent calls (why the option matters)', async () => {
        const { ethers } = await import('ethers');
        bodies.length = 0;
        const net = ethers.Network.from({ chainId: 10143, name: 'monad' });
        const p = new ethers.JsonRpcProvider(url, net, { staticNetwork: net });
        await Promise.all(Array.from({ length: 6 }, (_, i) => p.getBalance(addr(i))));
        expect(bodies.some((b) => Array.isArray(b))).toBe(true);
        p.destroy();
    });
});

// The QuickNode endpoint allows 50 requests/second per account; going over
// returned -32007 and crashed the server three times on 2026-09-28.
describe('RpcRateLimiter', () => {
    it('spaces requests so no more than the limit start in one second', async () => {
        const limiter = new RpcRateLimiter(20); // one slot every 50 ms
        const started: number[] = [];
        const t0 = Date.now();
        await Promise.all(Array.from({ length: 6 }, () => limiter.acquire().then(() => started.push(Date.now() - t0))));
        // 6 requests at 20/s: the last may start no earlier than 5 × 50 ms.
        expect(Math.max(...started)).toBeGreaterThanOrEqual(240);
        for (let i = 1; i < started.length; i++) expect(started[i]).toBeGreaterThanOrEqual(started[i - 1]);
    });

    it('charges a batch for every call in it', async () => {
        const limiter = new RpcRateLimiter(20);
        await limiter.acquire(5); // takes 5 slots = 250 ms
        const t0 = Date.now();
        await limiter.acquire();
        expect(Date.now() - t0).toBeGreaterThanOrEqual(240);
    });

    it('rejects a non-positive limit', () => {
        expect(() => new RpcRateLimiter(0)).toThrow();
    });
});

describe('createRpcProvider rate limiting', () => {
    let server: http.Server;
    let url: string;
    const arrivals: number[] = [];

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => (raw += c));
            req.on('end', () => {
                arrivals.push(Date.now());
                const body = JSON.parse(raw);
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x10' }));
            });
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('holds every provider sharing a limiter to its combined rate', async () => {
        const limiter = new RpcRateLimiter(20);
        const a = createRpcProvider(url, 10143, { name: 'a', limiter, fallbackUrl: null });
        const b = createRpcProvider(url, 10143, { name: 'b', limiter, fallbackUrl: null });
        const addr = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}`;
        const t0 = Date.now();
        await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).getBalance(addr(i))));
        expect(arrivals.length).toBe(6);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(240);
        a.destroy();
        b.destroy();
    });
});

// Monad's public RPC is the primary; MONAD_RPC_FALLBACK_URL (Alchemy) takes over
// when it refuses service. Two stub servers stand in for the two endpoints.
describe('createRpcProvider failover', () => {
    type Mode = 'ok' | 'rate-limited-body' | 'http-429' | 'http-503' | 'revert';
    let primaryMode: Mode = 'ok';
    const hits = { primary: [] as string[], fallback: [] as string[] };
    let primary: http.Server;
    let fallback: http.Server;
    let primaryUrl: string;
    let fallbackUrl: string;

    function stub(name: 'primary' | 'fallback') {
        return http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => (raw += c));
            req.on('end', () => {
                const body = JSON.parse(raw);
                hits[name].push(body.method);
                const mode = name === 'primary' ? primaryMode : 'ok';
                res.setHeader('content-type', 'application/json');
                if (mode === 'http-429' || mode === 'http-503') {
                    res.statusCode = mode === 'http-429' ? 429 : 503;
                    res.end('{}');
                    return;
                }
                const reply = mode === 'rate-limited-body'
                    ? { jsonrpc: '2.0', id: body.id, error: { code: -32007, message: '50/second request limit reached - reduce calls per second or upgrade your account' } }
                    : mode === 'revert'
                        ? { jsonrpc: '2.0', id: body.id, error: { code: 3, message: 'execution reverted', data: '0x' } }
                        : { jsonrpc: '2.0', id: body.id, result: name === 'primary' ? '0x10' : '0x20' };
                res.end(JSON.stringify(reply));
            });
        });
    }

    const listen = async (server: http.Server) => {
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };

    beforeAll(async () => {
        primary = stub('primary');
        fallback = stub('fallback');
        primaryUrl = await listen(primary);
        fallbackUrl = await listen(fallback);
    });
    afterAll(async () => {
        await new Promise<void>((r) => primary.close(() => r()));
        await new Promise<void>((r) => fallback.close(() => r()));
    });
    beforeEach(() => {
        resetRpcFailover();
        primaryMode = 'ok';
        hits.primary.length = 0;
        hits.fallback.length = 0;
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    const make = () => createRpcProvider(primaryUrl, 10143, {
        limiter: new RpcRateLimiter(1000),
        fallbackUrl,
        fallbackLimiter: new RpcRateLimiter(1000),
    });
    const ADDR = '0x' + '1'.repeat(40);

    it('uses only the primary while it is healthy', async () => {
        const p = make();
        expect(await p.getBalance(ADDR)).toBe(16n);
        expect(hits.fallback).toEqual([]);
        p.destroy();
    });

    it.each<Mode>(['rate-limited-body', 'http-429', 'http-503'])('re-sends to the fallback when the primary answers %s', async (mode) => {
        primaryMode = mode;
        const p = make();
        expect(await p.getBalance(ADDR)).toBe(32n);
        expect(hits.primary).toEqual(['eth_getBalance']); // no in-place retries against the primary
        expect(hits.fallback).toEqual(['eth_getBalance']);
        p.destroy();
    });

    it('re-sends to the fallback when the primary cannot be reached', async () => {
        const dead = createRpcProvider('http://127.0.0.1:1', 10143, {
            limiter: new RpcRateLimiter(1000), fallbackUrl, fallbackLimiter: new RpcRateLimiter(1000),
        });
        expect(await dead.getBalance(ADDR)).toBe(32n);
        dead.destroy();
    });

    it('does not fail over on a contract revert', async () => {
        primaryMode = 'revert';
        const p = make();
        await expect(p.call({ to: ADDR, data: '0x' })).rejects.toThrow();
        expect(hits.fallback).toEqual([]);
        p.destroy();
    });

    it('skips the primary for the cooldown — across providers — then goes back to it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            primaryMode = 'rate-limited-body';
            const a = make();
            const b = make();
            await a.getBalance(ADDR);
            primaryMode = 'ok';
            hits.primary.length = 0;

            await b.getBalance(ADDR);
            expect(hits.primary).toEqual([]);

            vi.setSystemTime(Date.now() + FAILOVER_COOLDOWN_MS + 1);
            // A different address: ethers briefly caches identical calls.
            expect(await b.getBalance('0x' + '2'.repeat(40))).toBe(16n);
            expect(hits.primary).toEqual(['eth_getBalance']);
            a.destroy();
            b.destroy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not re-send a transaction whose request failed in transit', async () => {
        primaryMode = 'http-503';
        const p = make();
        await expect(p.send('eth_sendRawTransaction', ['0x00'])).rejects.toThrow();
        expect(hits.fallback).toEqual([]);
        p.destroy();
    });

    it('does re-send a transaction the primary refused with a rate limit', async () => {
        primaryMode = 'http-429';
        const p = make();
        await p.send('eth_sendRawTransaction', ['0x00']);
        expect(hits.fallback).toEqual(['eth_sendRawTransaction']);
        p.destroy();
    });

    it('walks an ordered fallback list until an endpoint answers', async () => {
        primaryMode = 'http-503';
        const p = createRpcProvider('http://127.0.0.1:1', 10143, {
            limiter: new RpcRateLimiter(1000),
            fallbackUrl: `${primaryUrl}, ${fallbackUrl}`,
            fallbackLimiter: new RpcRateLimiter(1000),
        });
        expect(await p.getBalance(ADDR)).toBe(32n);
        expect(hits.primary).toEqual(['eth_getBalance']);
        expect(hits.fallback).toEqual(['eth_getBalance']);

        // Both failed endpoints are now skipped, not retried, during the cooldown.
        hits.primary.length = 0;
        expect(await p.getBalance('0x' + '2'.repeat(40))).toBe(32n);
        expect(hits.primary).toEqual([]);
        p.destroy();
    });

    it('without a fallback behaves exactly as before', async () => {
        primaryMode = 'rate-limited-body';
        const p = createRpcProvider(primaryUrl, 10143, { limiter: new RpcRateLimiter(1000), fallbackUrl: null });
        await expect(p.getBalance(ADDR)).rejects.toThrow(/request limit/);
        expect(hits.fallback).toEqual([]);
        p.destroy();
    });
});
