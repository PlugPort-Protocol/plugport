// T4: InMemoryKVStore batchWrite tests
// Validates that batch operations work correctly in dev mode.

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryKVStore } from '../storage/kv-adapter.js';

describe('InMemoryKVStore.batchWrite', () => {
    let store: InMemoryKVStore;

    beforeEach(() => {
        store = new InMemoryKVStore();
    });

    it('should handle empty batch', async () => {
        await store.batchWrite([], []);
        expect(store.getKeyCount()).toBe(0);
    });

    it('should insert multiple keys atomically', async () => {
        await store.batchWrite(
            [
                { key: 'key1', value: Buffer.from('value1') },
                { key: 'key2', value: Buffer.from('value2') },
                { key: 'key3', value: Buffer.from('value3') },
            ],
            []
        );

        expect(store.getKeyCount()).toBe(3);
        expect((await store.get('key1'))!.toString()).toBe('value1');
        expect((await store.get('key2'))!.toString()).toBe('value2');
        expect((await store.get('key3'))!.toString()).toBe('value3');
    });

    it('should delete multiple keys', async () => {
        await store.put('a', Buffer.from('1'));
        await store.put('b', Buffer.from('2'));
        await store.put('c', Buffer.from('3'));

        await store.batchWrite([], ['a', 'c']);

        expect(store.getKeyCount()).toBe(1);
        expect(await store.get('a')).toBeNull();
        expect((await store.get('b'))!.toString()).toBe('2');
        expect(await store.get('c')).toBeNull();
    });

    it('should handle puts and deletes in same batch', async () => {
        await store.put('old1', Buffer.from('old'));
        await store.put('old2', Buffer.from('old'));

        await store.batchWrite(
            [
                { key: 'new1', value: Buffer.from('new') },
                { key: 'new2', value: Buffer.from('new') },
            ],
            ['old1', 'old2']
        );

        expect(store.getKeyCount()).toBe(2);
        expect(await store.get('old1')).toBeNull();
        expect(await store.get('old2')).toBeNull();
        expect((await store.get('new1'))!.toString()).toBe('new');
        expect((await store.get('new2'))!.toString()).toBe('new');
    });

    it('should accept Uint8Array values', async () => {
        const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
        await store.batchWrite(
            [{ key: 'bytes', value: data }],
            []
        );

        const result = await store.get('bytes');
        expect(result).toBeTruthy();
        expect(result!.toString()).toBe('Hello');
    });

    it('should overwrite existing keys', async () => {
        await store.put('key', Buffer.from('original'));

        await store.batchWrite(
            [{ key: 'key', value: Buffer.from('updated') }],
            []
        );

        expect((await store.get('key'))!.toString()).toBe('updated');
    });

    it('should handle deleting non-existent keys gracefully', async () => {
        await store.batchWrite([], ['nonexistent1', 'nonexistent2']);
        expect(store.getKeyCount()).toBe(0);
    });
});
