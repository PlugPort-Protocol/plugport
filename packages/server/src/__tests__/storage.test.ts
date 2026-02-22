// PlugPort Server Unit Tests
// Comprehensive tests for KV adapter, key encoding, index manager, query planner, and document store

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import {
    encodeDocKey, decodeDocKey,
    encodeIdxKey, decodeIdxKey,
    encodeMetaKey, decodeMetaKey,
    encodeValue, encodeNumber, encodeDate,
    docPrefix, idxPrefix, computeIndexRange,
} from '../storage/key-encoding.js';
import { IndexManager, IndexError } from '../storage/index-manager.js';
import { planQuery, matchesFilter } from '../storage/query-planner.js';
import { DocumentStore, DocumentStoreError } from '../storage/document-store.js';

// =====================================================
// KV Adapter Tests
// =====================================================
describe('InMemoryKVStore', () => {
    let store: InMemoryKVStore;

    beforeEach(() => {
        store = new InMemoryKVStore();
    });

    it('should put and get a value', async () => {
        await store.put('key1', Buffer.from('value1'));
        const result = await store.get('key1');
        expect(result?.toString()).toBe('value1');
    });

    it('should return null for missing keys', async () => {
        const result = await store.get('nonexistent');
        expect(result).toBeNull();
    });

    it('should delete keys', async () => {
        await store.put('key1', Buffer.from('value1'));
        const deleted = await store.delete('key1');
        expect(deleted).toBe(true);
        expect(await store.get('key1')).toBeNull();
    });

    it('should return false when deleting non-existent key', async () => {
        const deleted = await store.delete('nonexistent');
        expect(deleted).toBe(false);
    });

    it('should check key existence', async () => {
        await store.put('key1', Buffer.from('value1'));
        expect(await store.has('key1')).toBe(true);
        expect(await store.has('key2')).toBe(false);
    });

    it('should scan by prefix', async () => {
        await store.put('doc:users:1', Buffer.from('user1'));
        await store.put('doc:users:2', Buffer.from('user2'));
        await store.put('doc:orders:1', Buffer.from('order1'));
        await store.put('idx:users:email:a', Buffer.from('1'));

        const results = await store.scan({ prefix: 'doc:users:' });
        expect(results.length).toBe(2);
        expect(results[0].key).toBe('doc:users:1');
        expect(results[1].key).toBe('doc:users:2');
    });

    it('should scan with limit', async () => {
        for (let i = 0; i < 10; i++) {
            await store.put(`key:${i.toString().padStart(2, '0')}`, Buffer.from(`val${i}`));
        }
        const results = await store.scan({ prefix: 'key:', limit: 3 });
        expect(results.length).toBe(3);
    });

    it('should count keys with prefix', async () => {
        await store.put('doc:users:1', Buffer.from('1'));
        await store.put('doc:users:2', Buffer.from('2'));
        await store.put('doc:orders:1', Buffer.from('3'));

        expect(await store.count('doc:users:')).toBe(2);
        expect(await store.count('doc:orders:')).toBe(1);
        expect(await store.count()).toBe(3);
    });

    it('should clear all keys', async () => {
        await store.put('key1', Buffer.from('1'));
        await store.put('key2', Buffer.from('2'));
        await store.clear();
        expect(store.getKeyCount()).toBe(0);
    });

    it('should maintain lexicographic ordering in scans', async () => {
        // Insert in random order
        await store.put('c', Buffer.from('3'));
        await store.put('a', Buffer.from('1'));
        await store.put('b', Buffer.from('2'));

        const results = await store.scan({});
        expect(results.map(r => r.key)).toEqual(['a', 'b', 'c']);
    });
});

// =====================================================
// Key Encoding Tests
// =====================================================
describe('Key Encoding', () => {
    describe('Document keys', () => {
        it('should encode doc keys', () => {
            expect(encodeDocKey('users', 'abc123')).toBe('doc:users:abc123');
        });

        it('should decode doc keys', () => {
            const result = decodeDocKey('doc:users:abc123');
            expect(result).toEqual({ collection: 'users', id: 'abc123' });
        });

        it('should return null for invalid doc keys', () => {
            expect(decodeDocKey('invalid')).toBeNull();
            expect(decodeDocKey('idx:users:1')).toBeNull();
        });
    });

    describe('Index keys', () => {
        it('should encode idx keys', () => {
            const key = encodeIdxKey('users', 'email', 'alice@test.com', 'id1');
            expect(key).toContain('idx:users:email:');
            expect(key).toContain('\x1Fid1');
        });

        it('should decode idx keys', () => {
            const key = 'idx:users:email:3:alice\x1Fid1';
            const result = decodeIdxKey(key);
            expect(result?.collection).toBe('users');
            expect(result?.field).toBe('email');
            expect(result?.id).toBe('id1');
        });
    });

    describe('Metadata keys', () => {
        it('should encode meta keys', () => {
            expect(encodeMetaKey('users')).toBe('meta:collection:users');
        });

        it('should decode meta keys', () => {
            expect(decodeMetaKey('meta:collection:users')).toBe('users');
        });
    });

    describe('Value encoding', () => {
        it('should encode null values', () => {
            expect(encodeValue(null)).toBe('0:');
            expect(encodeValue(undefined)).toBe('0:');
        });

        it('should encode booleans', () => {
            const f = encodeValue(false);
            const t = encodeValue(true);
            expect(f < t).toBe(true); // false < true in sort order
        });

        it('should encode strings', () => {
            expect(encodeValue('hello')).toBe('3:hello');
        });

        it('should preserve sort order for positive numbers', () => {
            const a = encodeNumber(1);
            const b = encodeNumber(10);
            const c = encodeNumber(100);
            expect(a < b).toBe(true);
            expect(b < c).toBe(true);
        });

        it('should preserve sort order for negative numbers', () => {
            const a = encodeNumber(-100);
            const b = encodeNumber(-10);
            const c = encodeNumber(-1);
            expect(a < b).toBe(true);
            expect(b < c).toBe(true);
        });

        it('should sort negative before positive', () => {
            const neg = encodeNumber(-1);
            const zero = encodeNumber(0);
            const pos = encodeNumber(1);
            expect(neg < zero).toBe(true);
            expect(zero < pos).toBe(true);
        });

        it('should encode dates', () => {
            const d1 = encodeDate(new Date('2024-01-01'));
            const d2 = encodeDate(new Date('2025-01-01'));
            expect(d1 < d2).toBe(true);
        });
    });

    describe('Prefix helpers', () => {
        it('should generate doc prefix', () => {
            expect(docPrefix('users')).toBe('doc:users:');
        });

        it('should generate idx prefix', () => {
            expect(idxPrefix('users', 'email')).toBe('idx:users:email:');
        });
    });

    describe('Index range computation', () => {
        it('should compute equality range', () => {
            const range = computeIndexRange('users', 'email', { $eq: 'alice@test.com' });
            expect(range.startKey).toContain('idx:users:email:');
            expect(range.endKey).toContain('idx:users:email:');
        });

        it('should compute range query bounds', () => {
            const range = computeIndexRange('users', 'age', { $gte: 18, $lt: 65 });
            expect(range.startKey).toBeTruthy();
            expect(range.endKey).toBeTruthy();
        });
    });
});

// =====================================================
// Index Manager Tests
// =====================================================
describe('IndexManager', () => {
    let kv: InMemoryKVStore;
    let indexManager: IndexManager;

    beforeEach(() => {
        kv = new InMemoryKVStore();
        indexManager = new IndexManager(kv);
    });

    it('should create an index', async () => {
        const meta = { name: 'users', indexes: [], options: { createdAt: 0, schemaVersion: 1 }, documentCount: 0 };
        const indexDef = await indexManager.createIndex(meta, 'email', true, []);
        expect(indexDef.name).toBe('email_1');
        expect(indexDef.field).toBe('email');
        expect(indexDef.unique).toBe(true);
    });

    it('should maintain indexes on insert', async () => {
        const indexes = [{ name: 'email_1', field: 'email', unique: true }];
        await indexManager.onInsert('users', indexes, { email: 'alice@test.com', name: 'Alice' }, 'id1');

        const entries = await kv.scan({ prefix: 'idx:users:email:' });
        expect(entries.length).toBe(1);
    });

    it('should enforce unique constraints', async () => {
        const indexes = [{ name: 'email_1', field: 'email', unique: true }];
        await indexManager.onInsert('users', indexes, { email: 'alice@test.com' }, 'id1');

        await expect(
            indexManager.onInsert('users', indexes, { email: 'alice@test.com' }, 'id2')
        ).rejects.toThrow(IndexError);
    });

    it('should update index entries on document update', async () => {
        const indexes = [{ name: 'email_1', field: 'email', unique: true }];
        await indexManager.onInsert('users', indexes, { email: 'old@test.com' }, 'id1');

        await indexManager.onUpdate(
            'users', indexes,
            { email: 'old@test.com' },
            { email: 'new@test.com' },
            'id1'
        );

        const oldEntries = await kv.scan({ prefix: 'idx:users:email:3:old' });
        expect(oldEntries.length).toBe(0);

        const newEntries = await kv.scan({ prefix: 'idx:users:email:3:new' });
        expect(newEntries.length).toBe(1);
    });

    it('should remove index entries on delete', async () => {
        const indexes = [{ name: 'email_1', field: 'email', unique: true }];
        await indexManager.onInsert('users', indexes, { email: 'test@test.com' }, 'id1');
        await indexManager.onDelete('users', indexes, { email: 'test@test.com' }, 'id1');

        const entries = await kv.scan({ prefix: 'idx:users:email:' });
        expect(entries.length).toBe(0);
    });
});

// =====================================================
// Query Planner Tests
// =====================================================
describe('Query Planner', () => {
    const indexes = [
        { name: '_id_', field: '_id', unique: true },
        { name: 'email_1', field: 'email', unique: true },
        { name: 'age_1', field: 'age', unique: false },
    ];

    describe('planQuery', () => {
        it('should use collection scan for empty filter', () => {
            const plan = planQuery({}, indexes, 'users');
            expect(plan.type).toBe('collectionScan');
        });

        it('should use index scan for exact match on indexed field', () => {
            const plan = planQuery({ email: 'alice@test.com' }, indexes, 'users');
            expect(plan.type).toBe('indexScan');
            expect(plan.indexField).toBe('email');
        });

        it('should use index scan for range query on indexed field', () => {
            const plan = planQuery({ age: { $gte: 18, $lt: 65 } }, indexes, 'users');
            expect(plan.type).toBe('indexScan');
            expect(plan.indexField).toBe('age');
        });

        it('should fall back to collection scan for non-indexed fields', () => {
            const plan = planQuery({ name: 'Alice' }, indexes, 'users');
            expect(plan.type).toBe('collectionScan');
        });

        it('should set needsPostFilter when multiple fields in filter', () => {
            const plan = planQuery({ email: 'alice@test.com', name: 'Alice' }, indexes, 'users');
            expect(plan.type).toBe('indexScan');
            expect(plan.needsPostFilter).toBe(true);
        });
    });

    describe('matchesFilter', () => {
        const doc = { _id: '1', name: 'Alice', age: 30, email: 'alice@test.com' };

        it('should match empty filter', () => {
            expect(matchesFilter(doc, {})).toBe(true);
        });

        it('should match exact values', () => {
            expect(matchesFilter(doc, { name: 'Alice' })).toBe(true);
            expect(matchesFilter(doc, { name: 'Bob' })).toBe(false);
        });

        it('should match $gt', () => {
            expect(matchesFilter(doc, { age: { $gt: 25 } })).toBe(true);
            expect(matchesFilter(doc, { age: { $gt: 30 } })).toBe(false);
        });

        it('should match $gte', () => {
            expect(matchesFilter(doc, { age: { $gte: 30 } })).toBe(true);
            expect(matchesFilter(doc, { age: { $gte: 31 } })).toBe(false);
        });

        it('should match $lt', () => {
            expect(matchesFilter(doc, { age: { $lt: 35 } })).toBe(true);
            expect(matchesFilter(doc, { age: { $lt: 30 } })).toBe(false);
        });

        it('should match $lte', () => {
            expect(matchesFilter(doc, { age: { $lte: 30 } })).toBe(true);
            expect(matchesFilter(doc, { age: { $lte: 29 } })).toBe(false);
        });

        it('should match $eq', () => {
            expect(matchesFilter(doc, { age: { $eq: 30 } })).toBe(true);
            expect(matchesFilter(doc, { age: { $eq: 31 } })).toBe(false);
        });

        it('should match $ne', () => {
            expect(matchesFilter(doc, { age: { $ne: 31 } })).toBe(true);
            expect(matchesFilter(doc, { age: { $ne: 30 } })).toBe(false);
        });

        it('should match $in', () => {
            expect(matchesFilter(doc, { name: { $in: ['Alice', 'Bob'] } })).toBe(true);
            expect(matchesFilter(doc, { name: { $in: ['Bob', 'Charlie'] } })).toBe(false);
        });

        it('should match $and', () => {
            expect(matchesFilter(doc, { $and: [{ name: 'Alice' }, { age: { $gte: 30 } }] })).toBe(true);
            expect(matchesFilter(doc, { $and: [{ name: 'Alice' }, { age: { $gte: 31 } }] })).toBe(false);
        });

        it('should match multiple field conditions (implicit AND)', () => {
            expect(matchesFilter(doc, { name: 'Alice', age: 30 })).toBe(true);
            expect(matchesFilter(doc, { name: 'Alice', age: 31 })).toBe(false);
        });
    });
});

// =====================================================
// Document Store Tests
// =====================================================
describe('DocumentStore', () => {
    let kv: InMemoryKVStore;
    let store: DocumentStore;

    beforeEach(() => {
        kv = new InMemoryKVStore();
        store = new DocumentStore(kv);
    });

    describe('Collection management', () => {
        it('should auto-create collections', async () => {
            const meta = await store.getOrCreateCollection('users');
            expect(meta.name).toBe('users');
            expect(meta.indexes.length).toBe(1); // _id index
        });

        it('should list collections', async () => {
            await store.insert('users', [{ name: 'Alice' }]);
            await store.insert('products', [{ name: 'Widget' }]);

            const collections = await store.listCollections();
            expect(collections.length).toBe(2);
        });

        it('should drop collections', async () => {
            await store.insert('users', [{ name: 'Alice' }]);
            const dropped = await store.dropCollection('users');
            expect(dropped).toBe(true);

            const collections = await store.listCollections();
            expect(collections.length).toBe(0);
        });
    });

    describe('Insert', () => {
        it('should insert a document', async () => {
            const result = await store.insert('users', [{ name: 'Alice', email: 'alice@test.com' }]);
            expect(result.acknowledged).toBe(true);
            expect(result.insertedId).toBeTruthy();
            expect(result.insertedCount).toBe(1);
        });

        it('should auto-generate _id', async () => {
            const result = await store.insert('users', [{ name: 'Alice' }]);
            expect(result.insertedId).toBeTruthy();
            expect(result.insertedId!.length).toBe(24);
        });

        it('should use provided _id', async () => {
            const result = await store.insert('users', [{ _id: 'custom-id', name: 'Alice' }]);
            expect(result.insertedId).toBe('custom-id');
        });

        it('should insert multiple documents', async () => {
            const result = await store.insert('users', [
                { name: 'Alice' },
                { name: 'Bob' },
                { name: 'Charlie' },
            ]);
            expect(result.insertedCount).toBe(3);
        });

        it('should enforce unique _id', async () => {
            await store.insert('users', [{ _id: 'id1', name: 'Alice' }]);
            await expect(
                store.insert('users', [{ _id: 'id1', name: 'Bob' }])
            ).rejects.toThrow(DocumentStoreError);
        });

        it('should reject oversized documents', async () => {
            const tinyStore = new DocumentStore(kv, 100); // 100 byte limit
            const largeDoc = { data: 'x'.repeat(200) };
            await expect(
                tinyStore.insert('test', [largeDoc])
            ).rejects.toThrow(DocumentStoreError);
        });
    });

    describe('Find', () => {
        beforeEach(async () => {
            await store.insert('users', [
                { _id: '1', name: 'Alice', age: 30, email: 'alice@test.com' },
                { _id: '2', name: 'Bob', age: 25, email: 'bob@test.com' },
                { _id: '3', name: 'Charlie', age: 35, email: 'charlie@test.com' },
            ]);
        });

        it('should find all documents', async () => {
            const result = await store.find('users');
            expect(result.cursor.firstBatch.length).toBe(3);
        });

        it('should filter by exact match', async () => {
            const result = await store.find('users', { name: 'Alice' });
            expect(result.cursor.firstBatch.length).toBe(1);
            expect(result.cursor.firstBatch[0].name).toBe('Alice');
        });

        it('should filter by range', async () => {
            const result = await store.find('users', { age: { $gte: 30 } });
            expect(result.cursor.firstBatch.length).toBe(2);
        });

        it('should apply limit', async () => {
            const result = await store.find('users', {}, { limit: 2 });
            expect(result.cursor.firstBatch.length).toBe(2);
        });

        it('should apply skip', async () => {
            const result = await store.find('users', {}, { skip: 1 });
            expect(result.cursor.firstBatch.length).toBe(2);
        });

        it('should apply sort', async () => {
            const result = await store.find('users', {}, { sort: { age: -1 } });
            expect(result.cursor.firstBatch[0].name).toBe('Charlie');
            expect(result.cursor.firstBatch[2].name).toBe('Bob');
        });

        it('should apply projection (include)', async () => {
            const result = await store.find('users', { _id: '1' }, { projection: { name: 1 } });
            const doc = result.cursor.firstBatch[0];
            expect(doc.name).toBe('Alice');
            expect(doc._id).toBeTruthy();
            expect((doc as Record<string, unknown>).email).toBeUndefined();
        });

        it('should apply projection (exclude)', async () => {
            const result = await store.find('users', { _id: '1' }, { projection: { email: 0 } });
            const doc = result.cursor.firstBatch[0];
            expect(doc.name).toBe('Alice');
            expect((doc as Record<string, unknown>).email).toBeUndefined();
        });

        it('should return empty for non-existent collection', async () => {
            const result = await store.find('nonexistent');
            expect(result.cursor.firstBatch.length).toBe(0);
        });
    });

    describe('Update', () => {
        beforeEach(async () => {
            await store.insert('users', [
                { _id: '1', name: 'Alice', age: 30 },
            ]);
        });

        it('should update a document with $set', async () => {
            const result = await store.updateOne('users', { _id: '1' }, { $set: { age: 31 } });
            expect(result.matchedCount).toBe(1);
            expect(result.modifiedCount).toBe(1);

            const found = await store.find('users', { _id: '1' });
            expect(found.cursor.firstBatch[0].age).toBe(31);
        });

        it('should return matchedCount 0 for no match', async () => {
            const result = await store.updateOne('users', { _id: 'nonexistent' }, { $set: { age: 31 } });
            expect(result.matchedCount).toBe(0);
        });

        it('should support upsert', async () => {
            const result = await store.updateOne(
                'users', { name: 'NewUser' }, { $set: { age: 20 } }, { upsert: true }
            );
            expect(result.upsertedId).toBeTruthy();

            const found = await store.find('users', { name: 'NewUser' });
            expect(found.cursor.firstBatch.length).toBe(1);
        });
    });

    describe('Delete', () => {
        beforeEach(async () => {
            await store.insert('users', [
                { _id: '1', name: 'Alice', age: 30 },
                { _id: '2', name: 'Bob', age: 25 },
                { _id: '3', name: 'Charlie', age: 35 },
            ]);
        });

        it('should delete a document', async () => {
            const result = await store.deleteOne('users', { _id: '1' });
            expect(result.deletedCount).toBe(1);

            const found = await store.find('users');
            expect(found.cursor.firstBatch.length).toBe(2);
        });

        it('should delete many documents', async () => {
            const result = await store.deleteMany('users', { age: { $gte: 30 } });
            expect(result.deletedCount).toBe(2);
        });

        it('should return 0 for no match', async () => {
            const result = await store.deleteOne('users', { _id: 'nonexistent' });
            expect(result.deletedCount).toBe(0);
        });
    });

    describe('Indexes', () => {
        it('should create an index', async () => {
            await store.insert('users', [{ name: 'Alice', email: 'alice@test.com' }]);
            const result = await store.createIndex('users', 'email', true);
            expect(result.indexName).toBe('email_1');
        });

        it('should use index for queries after creation', async () => {
            await store.insert('users', [
                { _id: '1', name: 'Alice', email: 'alice@test.com' },
                { _id: '2', name: 'Bob', email: 'bob@test.com' },
            ]);
            await store.createIndex('users', 'email', true);

            const result = await store.find('users', { email: 'alice@test.com' });
            expect(result.cursor.firstBatch.length).toBe(1);
            expect(result.cursor.firstBatch[0].name).toBe('Alice');
        });

        it('should enforce unique index on insert', async () => {
            await store.createIndex('users', 'email', true);
            await store.insert('users', [{ email: 'alice@test.com' }]);
            await expect(
                store.insert('users', [{ email: 'alice@test.com' }])
            ).rejects.toThrow(DocumentStoreError);
        });

        it('should list indexes', async () => {
            await store.getOrCreateCollection('users');
            await store.createIndex('users', 'email', true);
            const indexes = await store.listIndexes('users');
            expect(indexes.length).toBe(2); // _id + email
        });

        it('should drop an index', async () => {
            await store.getOrCreateCollection('users');
            await store.createIndex('users', 'email', true);
            const dropped = await store.dropIndex('users', 'email_1');
            expect(dropped).toBe(true);

            const indexes = await store.listIndexes('users');
            expect(indexes.length).toBe(1); // only _id
        });

        it('should not allow dropping _id index', async () => {
            await store.getOrCreateCollection('users');
            await expect(
                store.dropIndex('users', '_id_')
            ).rejects.toThrow(DocumentStoreError);
        });
    });

    describe('Collection stats', () => {
        it('should return stats', async () => {
            await store.insert('users', [{ name: 'Alice' }, { name: 'Bob' }]);
            const stats = await store.getStats('users');
            expect(stats.documentCount).toBe(2);
            expect(stats.indexCount).toBe(1);
            expect(stats.storageSizeBytes).toBeGreaterThan(0);
        });
    });
});
