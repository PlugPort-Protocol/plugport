// The Monad public RPC rejects most batched and parallel requests, and ethers'
// JsonRpcProvider batches concurrent calls by default — see storage/rpc-provider.ts
// for the measurements. These tests run against a local stub server so they can
// assert what actually goes over the wire, without touching the network.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRpcProvider } from '../storage/rpc-provider.js';

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
