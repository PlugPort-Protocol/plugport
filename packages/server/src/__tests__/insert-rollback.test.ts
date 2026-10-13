// An insert that fails partway must not leave index entries for documents
// that were never stored. A leftover unique _id entry made that _id
// impossible to insert ever again ("duplicate key" with no document).

import { describe, it, expect } from 'vitest';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';

const ids = async (store: DocumentStore, c: string) =>
    (await store.find(c, {})).cursor.firstBatch.map((d) => d._id).sort();

describe('insert rollback', () => {
    it('a duplicate in a batch leaves the batch\'s other _ids insertable', async () => {
        const store = new DocumentStore(new InMemoryKVStore());
        await store.insert('c', [{ _id: 'a' }]);

        await expect(store.insert('c', [{ _id: 'd' }, { _id: 'e' }, { _id: 'a' }])).rejects.toMatchObject({ code: 11000 });
        expect(await ids(store, 'c')).toEqual(['a']);

        await store.insert('c', [{ _id: 'd' }, { _id: 'e' }]);
        expect(await ids(store, 'c')).toEqual(['a', 'd', 'e']);
        expect((await store.getCollection('c'))!.documentCount).toBe(3);
    });

    it('rolls back secondary unique index entries too', async () => {
        const store = new DocumentStore(new InMemoryKVStore());
        await store.createIndex('c', 'email', true);
        await store.insert('c', [{ _id: 'a', email: 'a@x' }]);

        await expect(store.insert('c', [{ _id: 'b', email: 'b@x' }, { _id: 'c2', email: 'a@x' }])).rejects.toMatchObject({ code: 11000 });
        await store.insert('c', [{ _id: 'b', email: 'b@x' }]);
        expect(await ids(store, 'c')).toEqual(['a', 'b']);
    });

    it('an oversized document leaves the batch\'s other _ids insertable', async () => {
        const store = new DocumentStore(new InMemoryKVStore(), 100);
        await expect(store.insert('c', [{ _id: 'x' }, { _id: 'y', big: 'z'.repeat(200) }])).rejects.toThrow(/maximum size/);
        await store.insert('c', [{ _id: 'x' }]);
        expect(await ids(store, 'c')).toEqual(['x']);
    });

    it('a failed batch write leaves its _ids insertable', async () => {
        const kv = new InMemoryKVStore();
        const store = new DocumentStore(kv);
        const realBatchWrite = kv.batchWrite.bind(kv);
        kv.batchWrite = async () => { throw new Error('storage unavailable'); };
        await expect(store.insert('c', [{ _id: 'p' }, { _id: 'q' }])).rejects.toThrow('storage unavailable');

        kv.batchWrite = realBatchWrite;
        await store.insert('c', [{ _id: 'p' }, { _id: 'q' }]);
        expect(await ids(store, 'c')).toEqual(['p', 'q']);
    });

    it('without batchWrite, documents stored before the failure stay and are counted', async () => {
        const kv = new InMemoryKVStore();
        (kv as { batchWrite?: unknown }).batchWrite = undefined;
        const store = new DocumentStore(kv);
        await store.insert('c', [{ _id: 'a' }]);

        await expect(store.insert('c', [{ _id: 'd' }, { _id: 'a' }])).rejects.toMatchObject({ code: 11000 });
        expect(await ids(store, 'c')).toEqual(['a', 'd']);
        expect((await store.getCollection('c'))!.documentCount).toBe(2);
    });
});
