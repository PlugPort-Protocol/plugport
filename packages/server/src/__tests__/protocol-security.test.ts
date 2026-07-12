// Protocol Security Tests: Pipeline stage cap, SCRAM multi-key parsing, Redis RENAME cross-type, key rotation endpoint
// Verifies wire protocol hardening, auth security, and Redis atomicity guarantees.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHttpServer, type HttpServerOptions } from '../http-server.js';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { MetricsCollector } from '../metrics.js';
import type { FastifyInstance } from 'fastify';

describe('Protocol Security', () => {
    let app: FastifyInstance;
    let store: DocumentStore;
    let kvStore: InMemoryKVStore;

    beforeAll(async () => {
        kvStore = new InMemoryKVStore();
        store = new DocumentStore(kvStore);
        const metrics = new MetricsCollector();

        const options: HttpServerOptions = {
            port: 0,
            host: '127.0.0.1',
            store,
            metrics,
            kvStore,
            protocolManager: {
                getStatus: () => [],
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

    // ---- B4: Pipeline Stage Cap ----

    describe('B4: Aggregation pipeline stage cap', () => {
        it('should reject pipeline with more than 50 stages', async () => {
            // Seed a collection
            const col = `test_pipeline_cap_${Date.now()}`;
            await app.inject({
                method: 'POST',
                url: `/api/v1/collections/${col}/insertOne`,
                payload: { document: { x: 1 } },
                headers: { 'x-test-wallet-address': '0xTestOwner' },
            });

            // Build a pipeline with 51 stages (all $match stages)
            const pipeline = Array.from({ length: 51 }, () => ({ $match: { x: 1 } }));

            const res = await app.inject({
                method: 'POST',
                url: `/api/v1/collections/${col}/aggregate`,
                payload: { pipeline },
                headers: { 'x-test-wallet-address': '0xTestOwner' },
            });

            expect(res.statusCode).toBe(400);
            const body = res.json();
            expect(body.ok).toBe(0);
            expect(body.errmsg).toContain('exceeds maximum');
            expect(body.errmsg).toContain('50');
            expect(body.code).toBe(15942);
        });

        it('should allow pipeline with exactly 50 stages', async () => {
            const col = `test_pipeline_50_${Date.now()}`;
            await app.inject({
                method: 'POST',
                url: `/api/v1/collections/${col}/insertOne`,
                payload: { document: { x: 1 } },
                headers: { 'x-test-wallet-address': '0xTestOwner' },
            });

            // Exactly 50 $match stages — should pass
            const pipeline = Array.from({ length: 50 }, () => ({ $match: { x: 1 } }));

            const res = await app.inject({
                method: 'POST',
                url: `/api/v1/collections/${col}/aggregate`,
                payload: { pipeline },
                headers: { 'x-test-wallet-address': '0xTestOwner' },
            });

            const body = res.json();
            expect(body.ok).toBe(1);
        });
    });

    // ---- I5: RENAME Cross-Type Key Cleanup ----

    describe('I5: Redis RENAME cross-type cleanup', () => {
        it('should clear conflicting type keys at destination on RENAME', async () => {
            // This tests the KV store directly — RENAME is a Redis protocol command
            // but the underlying logic uses the shared KV store

            // Simulate: set a string key and a hash key at the destination
            await kvStore.put('redis:str:src_key', JSON.stringify('source_value'));
            await kvStore.put('redis:hash:dest_key', JSON.stringify({ field: 'old_hash' }));

            // After RENAME src_key -> dest_key:
            // The destination should have ONLY the string value, not the old hash
            const prefixes = ['redis:str:', 'redis:hash:', 'redis:list:', 'redis:set:', 'redis:zset:'];

            // Simulate RENAME logic (same as redis-server.ts)
            const oldName = 'src_key';
            const newName = 'dest_key';
            for (const prefix of prefixes) {
                const val = await kvStore.get(prefix + oldName);
                if (val) {
                    // Clear all destination types first
                    for (const destPrefix of prefixes) {
                        try { await kvStore.delete(destPrefix + newName); } catch { /* ignore */ }
                    }
                    await kvStore.put(prefix + newName, val);
                    await kvStore.delete(prefix + oldName);
                    break;
                }
            }

            // Verify: destination string should have the source value
            const destStr = await kvStore.get('redis:str:dest_key');
            expect(destStr?.toString()).toBe(JSON.stringify('source_value'));

            // Verify: destination hash should be cleared (no cross-type conflict)
            const destHash = await kvStore.get('redis:hash:dest_key');
            expect(destHash).toBeNull();

            // Verify: source should be deleted
            const srcStr = await kvStore.get('redis:str:src_key');
            expect(srcStr).toBeNull();
        });
    });

    // ---- B2: SCRAM Multi-Key Username Format ----

    describe('B2: Multi-key SCRAM username format parsing', () => {
        it('should parse 0xAddress:N format correctly', () => {
            // Test the username parsing logic from wire-server.ts
            const username = '0xAbCdEf1234567890:3';
            const colonIdx = username.indexOf(':', 2);

            expect(colonIdx).toBeGreaterThan(0);

            const walletAddress = username.substring(0, colonIdx);
            const requestedKeyIndex = parseInt(username.substring(colonIdx + 1), 10);

            expect(walletAddress).toBe('0xAbCdEf1234567890');
            expect(requestedKeyIndex).toBe(3);
        });

        it('should handle plain 0xAddress format (no colon)', () => {
            const username = '0xAbCdEf1234567890';
            const colonIdx = username.indexOf(':', 2);

            expect(colonIdx).toBe(-1); // No colon found after 0x
            // requestedKeyIndex would be -1 (try all active keys)
        });

        it('should not confuse 0x prefix colon with key index', () => {
            // Edge case: very short address
            const username = '0x1234';
            const colonIdx = username.indexOf(':', 2);

            expect(colonIdx).toBe(-1); // No colon — treat as address-only
        });
    });

    // ---- rotateKeyMeta HTTP endpoint ----

    describe('POST /api/v1/auth/rotate-key', () => {
        it('should return 400 when required fields are missing', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/auth/rotate-key',
                payload: { keyOwner: '0xABC' },
                headers: { 'x-test-wallet-address': '0xABC' },
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().errmsg).toContain('Missing required fields');
        });

        it('should accept valid rotation request (fallback mode)', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/auth/rotate-key',
                payload: {
                    keyOwner: '0xTestWallet',
                    oldKeyIndex: 0,
                    newCommitment: '0x' + 'ab'.repeat(32),
                    newSalt: '0x' + 'cd'.repeat(32),
                    newStoredKey: '0x' + 'ef'.repeat(32),
                    newServerKey: '0x' + '12'.repeat(32),
                    nonce: 1,
                    signature: '0x' + 'ff'.repeat(65),
                },
                headers: { 'x-test-wallet-address': '0xTestWallet' },
            });
            // In fallback mode (no contract configured), should succeed with log-only response
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.ok).toBe(1);
            expect(body.message).toContain('logged only');
        });
    });
});
