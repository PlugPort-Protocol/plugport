// $or / $and next to an indexed field. The planner used to scan one $or
// branch's index range (missing documents that match only another branch)
// and to skip post-filtering when the only other condition was $or/$and
// (returning documents the $or/$and rejects).

import { describe, it, expect, beforeEach } from 'vitest';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { planQuery } from '../storage/query-planner.js';

let store: DocumentStore;

const ids = async (filter: Record<string, unknown>) =>
    (await store.find('c', filter)).cursor.firstBatch.map((d) => d._id).sort();

beforeEach(async () => {
    store = new DocumentStore(new InMemoryKVStore());
    await store.createIndex('c', 'email');
    await store.insert('c', [
        { _id: 'a', email: 'a@x', n: 1 },
        { _id: 'b', email: 'b@x', n: 2 },
        { _id: 'c', email: 'c@x', n: 3 },
    ]);
});

describe('$or and $and with indexed fields', () => {
    it('$or with an indexed branch returns every branch\'s matches', async () => {
        expect(await ids({ $or: [{ _id: 'a' }, { n: 2 }] })).toEqual(['a', 'b']);
        expect(await ids({ $or: [{ email: 'a@x' }, { email: 'c@x' }] })).toEqual(['a', 'c']);
        expect(planQuery({ $or: [{ _id: 'a' }, { n: 2 }] }, [{ name: '_id_', field: '_id', unique: true }], 'c').type).toBe('collectionScan');
    });

    it('an indexed equality next to $or still applies the $or', async () => {
        expect(await ids({ _id: 'a', $or: [{ n: 2 }, { n: 3 }] })).toEqual([]);
        expect(await ids({ email: 'b@x', $or: [{ n: 2 }, { n: 3 }] })).toEqual(['b']);
    });

    it('an indexed equality or range next to $and still applies the $and', async () => {
        expect(await ids({ _id: 'b', $and: [{ n: 1 }] })).toEqual([]);
        expect(await ids({ email: { $gte: 'a@x' }, $and: [{ n: { $gte: 2 } }] })).toEqual(['b', 'c']);
    });

    it('updateMany and deleteMany see every $or match', async () => {
        expect((await store.updateMany('c', { $or: [{ _id: 'a' }, { n: 3 }] }, { $set: { hit: true } })).matchedCount).toBe(2);
        expect((await store.deleteMany('c', { $or: [{ _id: 'a' }, { n: 2 }] })).deletedCount).toBe(2);
        expect(await ids({})).toEqual(['c']);
    });

    it('a lone indexed condition still skips the post-filter', () => {
        const indexes = [{ name: 'email_1', field: 'email', unique: false }];
        expect(planQuery({ email: 'a@x' }, indexes, 'c')).toMatchObject({ type: 'indexScan', needsPostFilter: false });
        expect(planQuery({ email: 'a@x', $or: [{ n: 1 }] }, indexes, 'c')).toMatchObject({ type: 'indexScan', needsPostFilter: true });
    });
});
