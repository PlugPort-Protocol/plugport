// Encryption Layer Tests
// Tests AES-256-GCM encryption, key derivation, and EncryptionLayer KV wrapper

import { describe, it, expect, beforeEach } from 'vitest';
import { EncryptionLayer } from '../storage/encryption-layer.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import type { KVAdapter } from '@plugport/shared';

describe('EncryptionLayer', () => {
    let baseStore: InMemoryKVStore;
    let encryptedStore: EncryptionLayer;
    const testKey = Buffer.alloc(32, 'a'); // 32-byte AES key

    beforeEach(() => {
        baseStore = new InMemoryKVStore();
        encryptedStore = new EncryptionLayer(baseStore, testKey);
    });

    describe('Basic operations', () => {
        it('should encrypt data on put and decrypt on get', async () => {
            const plaintext = Buffer.from('Hello, World!');
            await encryptedStore.put('key1', plaintext);

            // Read back via encrypted layer → should get plaintext
            const decrypted = await encryptedStore.get('key1');
            expect(decrypted).toBeTruthy();
            expect(decrypted!.toString()).toBe('Hello, World!');
        });

        it('should store encrypted data in base store', async () => {
            const plaintext = Buffer.from('Secret data');
            await encryptedStore.put('key1', plaintext);

            // Read from base store directly → should be encrypted (not plaintext)
            const rawValue = await baseStore.get('key1');
            expect(rawValue).toBeTruthy();
            expect(rawValue!.toString()).not.toBe('Secret data');
        });

        it('should return null for missing keys', async () => {
            const result = await encryptedStore.get('nonexistent');
            expect(result).toBeNull();
        });

        it('should delete keys', async () => {
            await encryptedStore.put('key1', Buffer.from('data'));
            const deleted = await encryptedStore.delete('key1');
            expect(deleted).toBe(true);
            expect(await encryptedStore.get('key1')).toBeNull();
        });

        it('should check key existence', async () => {
            await encryptedStore.put('key1', Buffer.from('data'));
            expect(await encryptedStore.has('key1')).toBe(true);
            expect(await encryptedStore.has('key2')).toBe(false);
        });
    });

    describe('Encryption properties', () => {
        it('should produce different ciphertext for same plaintext (unique IV)', async () => {
            const plaintext = Buffer.from('Same data');
            await encryptedStore.put('key1', plaintext);
            await encryptedStore.put('key2', plaintext);

            const raw1 = await baseStore.get('key1');
            const raw2 = await baseStore.get('key2');

            // Different IVs → different ciphertext
            expect(raw1!.toString('hex')).not.toBe(raw2!.toString('hex'));
        });

        it('should detect tampered ciphertext (GCM auth)', async () => {
            await encryptedStore.put('key1', Buffer.from('Original'));

            // Tamper with the stored value
            const rawValue = await baseStore.get('key1');
            if (rawValue) {
                const tampered = Buffer.from(rawValue);
                tampered[tampered.length - 1] ^= 0xff; // Flip last byte
                await baseStore.put('key1', tampered);
            }

            // Decryption should fail (GCM auth tag mismatch)
            await expect(encryptedStore.get('key1')).rejects.toThrow();
        });

        it('should fail decryption with wrong key', async () => {
            await encryptedStore.put('key1', Buffer.from('Secret'));

            // Create new encryption layer with different key
            const wrongKey = Buffer.alloc(32, 'b');
            const wrongLayer = new EncryptionLayer(baseStore, wrongKey);

            // Should fail to decrypt
            await expect(wrongLayer.get('key1')).rejects.toThrow();
        });
    });

    describe('Scan operations', () => {
        it('should scan and decrypt all values', async () => {
            await encryptedStore.put('doc:users:1', Buffer.from('Alice'));
            await encryptedStore.put('doc:users:2', Buffer.from('Bob'));
            await encryptedStore.put('doc:orders:1', Buffer.from('Order'));

            const results = await encryptedStore.scan({ prefix: 'doc:users:' });
            expect(results.length).toBe(2);
            expect(results[0].value.toString()).toBe('Alice');
            expect(results[1].value.toString()).toBe('Bob');
        });

        it('should scan with limit', async () => {
            for (let i = 0; i < 10; i++) {
                await encryptedStore.put(`key:${i}`, Buffer.from(`val${i}`));
            }
            const results = await encryptedStore.scan({ prefix: 'key:', limit: 3 });
            expect(results.length).toBe(3);
        });
    });

    describe('Batch operations', () => {
        it('should batch write with encryption', async () => {
            if (encryptedStore.batchWrite) {
                await encryptedStore.batchWrite(
                    [
                        { key: 'a', value: Buffer.from('val_a') },
                        { key: 'b', value: Buffer.from('val_b') },
                    ],
                    [],
                );

                expect((await encryptedStore.get('a'))!.toString()).toBe('val_a');
                expect((await encryptedStore.get('b'))!.toString()).toBe('val_b');
            }
        });
    });

    describe('Count and clear', () => {
        it('should count keys', async () => {
            await encryptedStore.put('a', Buffer.from('1'));
            await encryptedStore.put('b', Buffer.from('2'));
            expect(await encryptedStore.count()).toBe(2);
        });

        it('should clear all keys', async () => {
            await encryptedStore.put('a', Buffer.from('1'));
            await encryptedStore.clear();
            expect(await encryptedStore.count()).toBe(0);
        });
    });

    describe('Large data', () => {
        it('should handle large values', async () => {
            const largeData = Buffer.alloc(1024 * 100, 'x'); // 100KB
            await encryptedStore.put('large', largeData);
            const decrypted = await encryptedStore.get('large');
            expect(decrypted!.length).toBe(largeData.length);
            expect(decrypted!.toString()).toBe(largeData.toString());
        });

        it('should handle empty values', async () => {
            await encryptedStore.put('empty', Buffer.from(''));
            const decrypted = await encryptedStore.get('empty');
            expect(decrypted!.toString()).toBe('');
        });
    });
});
