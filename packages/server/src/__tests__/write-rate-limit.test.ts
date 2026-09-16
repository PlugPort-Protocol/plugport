// Gas-costing write routes had no stricter rate limit than the global
// default (100 req/10s per IP) — this session has repeatedly observed
// firsthand that even modest concurrent write bursts cause real on-chain
// RPC nonce contention, so a single IP hammering a write route was a direct,
// unmitigated path to gas-station exhaustion or starving out other callers.
// (see TODO.md). This proves the new stricter per-route WRITE_RATE_LIMIT
// (20 req/10s) actually kicks in on a write route, while a read route stays
// on the permissive global default.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHttpServer, type HttpServerOptions } from '../http-server.js';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { MetricsCollector } from '../metrics.js';
import type { FastifyInstance } from 'fastify';

describe('Write-route rate limiting', () => {
    let app: FastifyInstance;
    const headers = { 'x-test-wallet-address': '0xRateLimitTester' };

    beforeAll(async () => {
        const kvStore = new InMemoryKVStore();
        const store = new DocumentStore(kvStore);
        const metrics = new MetricsCollector();

        const options: HttpServerOptions = {
            port: 0,
            host: '127.0.0.1',
            store,
            metrics,
            kvStore,
            protocolManager: {
                getActiveProtocols: () => [],
                enableProtocol: async () => {},
                disableProtocol: async () => {},
            },
        };

        app = await createHttpServer(options);
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    it('insertOne is throttled well below the global 100/10s default', async () => {
        const results: number[] = [];
        for (let i = 0; i < 21; i++) {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/collections/rate_limit_test/insertOne',
                headers,
                payload: { document: { i } },
            });
            results.push(res.statusCode);
        }
        // First 20 succeed, the 21st is rate-limited.
        expect(results.filter(s => s === 200).length).toBe(20);
        expect(results[20]).toBe(429);
    });

    it('a read route (find) is NOT subject to the stricter write limit', async () => {
        const results: number[] = [];
        for (let i = 0; i < 25; i++) {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/collections/rate_limit_test/find',
                headers,
                payload: {},
            });
            results.push(res.statusCode);
        }
        // All 25 succeed — well under the global 100/10s default, and reads
        // were never in scope for the stricter write-only limit.
        expect(results.every(s => s === 200)).toBe(true);
    });
});
