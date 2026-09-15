// API Key Manager Tests
// Tests key generation/validation/revocation and the owner→keys index,
// including the concurrency behavior of addToOwnerIndex/removeFromOwnerIndex.

import { describe, it, expect } from 'vitest';
import { ApiKeyManager } from '../auth/api-key-manager.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';

describe('ApiKeyManager', () => {
    const makeManager = () => new ApiKeyManager(new InMemoryKVStore());

    describe('Basic operations', () => {
        it('should generate a key and list it for its owner', async () => {
            const manager = makeManager();
            const { hash } = await manager.generateKey('0xOwner', 'my-key');

            const keys = await manager.listKeys('0xOwner');
            expect(keys).toHaveLength(1);
            expect(keys[0].hash).toBe(hash);
        });

        it('should validate a generated key', async () => {
            const manager = makeManager();
            const { apiKey } = await manager.generateKey('0xOwner', 'my-key');

            const result = await manager.validateKey(apiKey);
            expect(result.valid).toBe(true);
            expect(result.ownerAddress).toBe('0xowner');
        });

        it('should remove a revoked key from the owner index', async () => {
            const manager = makeManager();
            const { hash } = await manager.generateKey('0xOwner', 'my-key');

            const revoked = await manager.revokeKey(hash, '0xOwner');
            expect(revoked).toBe(true);

            const keys = await manager.listKeys('0xOwner');
            expect(keys).toHaveLength(0);
        });
    });

    describe('Owner index concurrency', () => {
        it('should not lose keys when generating many keys for the same owner concurrently', async () => {
            const manager = makeManager();
            const N = 20;

            const results = await Promise.all(
                Array.from({ length: N }, (_, i) => manager.generateKey('0xOwner', `key-${i}`))
            );
            const generatedHashes = new Set(results.map(r => r.hash));
            expect(generatedHashes.size).toBe(N);

            // Before the owner-index Mutex fix, this read-modify-write race
            // on `meta:apikeys-by-owner:<address>` could silently drop
            // entries under concurrent writers (last-write-wins).
            const keys = await manager.listKeys('0xOwner');
            expect(keys).toHaveLength(N);
            const listedHashes = new Set(keys.map(k => k.hash));
            expect(listedHashes).toEqual(generatedHashes);
        });

        it('should not lose keys when revoking several keys for the same owner concurrently', async () => {
            const manager = makeManager();
            const N = 10;

            const generated = [];
            for (let i = 0; i < N; i++) {
                generated.push(await manager.generateKey('0xOwner', `key-${i}`));
            }

            // Revoke half of them concurrently.
            const toRevoke = generated.slice(0, 5);
            await Promise.all(toRevoke.map(k => manager.revokeKey(k.hash, '0xOwner')));

            const remaining = await manager.listKeys('0xOwner');
            expect(remaining).toHaveLength(N - 5);
            const remainingHashes = new Set(remaining.map(k => k.hash));
            for (const revoked of toRevoke) {
                expect(remainingHashes.has(revoked.hash)).toBe(false);
            }
        });

        it('should keep separate owners independent under concurrent writes', async () => {
            const manager = makeManager();
            await Promise.all([
                manager.generateKey('0xOwnerA', 'a1'),
                manager.generateKey('0xOwnerB', 'b1'),
                manager.generateKey('0xOwnerA', 'a2'),
                manager.generateKey('0xOwnerB', 'b2'),
            ]);

            expect(await manager.listKeys('0xOwnerA')).toHaveLength(2);
            expect(await manager.listKeys('0xOwnerB')).toHaveLength(2);
        });
    });
});
