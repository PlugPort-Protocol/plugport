// Until 2026-09-30 every query on an indexed field — including _id — returned no
// documents on the live server. The query planner's index scan passed only
// startKey/endKey, and MonadAdapter.scan finds keys by prefix in its key index,
// returning nothing without one. The in-memory store scans by range, which is
// why no test caught it. This store behaves like MonadAdapter in that respect.

import { describe, it, expect } from 'vitest';
import type { ScanOptions, KVEntry } from '@plugport/shared';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';

class PrefixOnlyScanStore extends InMemoryKVStore {
    override async scan(options: ScanOptions): Promise<KVEntry[]> {
        if (!options.prefix) return [];
        return super.scan(options);
    }
}

describe('index scans on a prefix-only store (MonadAdapter semantics)', () => {
    it('finds documents by _id and by an indexed field', async () => {
        const store = new DocumentStore(new PrefixOnlyScanStore());
        const { insertedIds } = await store.insert('products', [
            { name: 'Mouse', category: 'Peripherals' },
            { name: 'Keyboard', category: 'Peripherals' },
            { name: 'Sleeve', category: 'Accessories' },
        ]);
        await store.createIndex('products', 'category');

        expect((await store.find('products', { _id: insertedIds[0] })).cursor.firstBatch).toHaveLength(1);
        expect((await store.find('products', { category: 'Peripherals' })).cursor.firstBatch).toHaveLength(2);
        expect((await store.find('products', { category: { $gte: 'A', $lt: 'B' } })).cursor.firstBatch).toHaveLength(1);
    });
});
