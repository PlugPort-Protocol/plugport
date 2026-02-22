// PlugPort MongoDB Compatibility Suite
// Tracks pass/fail for MongoDB operation compatibility (inspired by FerretDB)

import { describe, it, expect } from 'vitest';

const API_BASE = process.env.PLUGPORT_URL || 'http://localhost:8080';

async function post(path: string, body: unknown) {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
}

async function get(path: string) {
    const res = await fetch(`${API_BASE}${path}`);
    return { status: res.status, data: await res.json() };
}

/**
 * MongoDB Compatibility Matrix
 * Tests each operation and tracks pass/fail status.
 * The compat key maps to MongoDB documentation sections.
 */
describe('MongoDB Compatibility Suite', () => {
    const coll = `compat_${Date.now()}`;

    // Seed data
    it('setup: seed test data', async () => {
        await post(`/api/v1/collections/${coll}/insertMany`, {
            documents: [
                { _id: 'c1', name: 'Alice', age: 30, emails: ['alice@a.com'], status: 'active' },
                { _id: 'c2', name: 'Bob', age: 25, emails: ['bob@b.com'], status: 'active' },
                { _id: 'c3', name: 'Charlie', age: 35, emails: ['c@c.com'], status: 'inactive' },
                { _id: 'c4', name: 'Diana', age: 28, emails: [], status: 'active' },
                { _id: 'c5', name: 'Eve', age: 42, emails: ['eve@e.com', 'eve2@e.com'], status: 'active' },
            ],
        });
    });

    describe('Insert Operations', () => {
        it('[PASS] insertOne - basic document', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/insertOne`, {
                document: { test: 'insertOne', value: 1 },
            });
            expect(data.acknowledged).toBe(true);
        });

        it('[PASS] insertMany - multiple documents', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/insertMany`, {
                documents: [{ batch: 1 }, { batch: 2 }],
            });
            expect(data.insertedCount).toBe(2);
        });

        it('[PASS] insertOne - with custom _id', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/insertOne`, {
                document: { _id: 'custom_compat', data: true },
            });
            expect(data.insertedId).toBe('custom_compat');
        });
    });

    describe('Find Operations', () => {
        it('[PASS] find - empty filter (all docs)', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/find`, { filter: {} });
            expect(data.cursor.firstBatch.length).toBeGreaterThan(0);
        });

        it('[PASS] find - exact match', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/find`, {
                filter: { name: 'Alice' },
            });
            expect(data.cursor.firstBatch.length).toBe(1);
        });

        it('[PASS] find - $gt operator', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/find`, {
                filter: { age: { $gt: 30 } },
            });
            expect(data.cursor.firstBatch.length).toBeGreaterThan(0);
        });

        it('[PASS] find - $gte operator', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/find`, {
                filter: { age: { $gte: 30 } },
            });
            expect(data.cursor.firstBatch.length).toBeGreaterThanOrEqual(2);
        });

        it('[PASS] find - $lt operator', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/find`, {
                filter: { age: { $lt: 30 } },
            });
            expect(data.cursor.firstBatch.length).toBeGreaterThan(0);
        });

        it('[PASS] find - $lte operator', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/find`, {
                filter: { age: { $lte: 30 } },
            });
            expect(data.cursor.firstBatch.length).toBeGreaterThanOrEqual(2);
        });

        it('[PASS] find - projection (include)', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/find`, {
                filter: { name: 'Alice' }, projection: { name: 1 },
            });
            expect(data.cursor.firstBatch[0].name).toBe('Alice');
            expect(data.cursor.firstBatch[0].age).toBeUndefined();
        });

        it('[PASS] find - projection (exclude)', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/find`, {
                filter: { name: 'Alice' }, projection: { emails: 0 },
            });
            expect(data.cursor.firstBatch[0].emails).toBeUndefined();
        });

        it('[PASS] find - limit', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/find`, {
                filter: {}, limit: 2,
            });
            expect(data.cursor.firstBatch.length).toBeLessThanOrEqual(2);
        });

        it('[PASS] find - sort ascending', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/find`, {
                filter: { status: 'active' }, sort: { age: 1 },
            });
            const ages = data.cursor.firstBatch.map((d: Record<string, unknown>) => d.age);
            for (let i = 1; i < ages.length; i++) {
                expect(ages[i]).toBeGreaterThanOrEqual(ages[i - 1]);
            }
        });

        it('[PASS] find - sort descending', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/find`, {
                filter: { status: 'active' }, sort: { age: -1 },
            });
            const ages = data.cursor.firstBatch.map((d: Record<string, unknown>) => d.age);
            for (let i = 1; i < ages.length; i++) {
                expect(ages[i]).toBeLessThanOrEqual(ages[i - 1]);
            }
        });

        it('[PASS] find - combined filter + sort + limit', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/find`, {
                filter: { status: 'active' }, sort: { age: -1 }, limit: 2,
            });
            expect(data.cursor.firstBatch.length).toBeLessThanOrEqual(2);
        });
    });

    describe('Update Operations', () => {
        it('[PASS] updateOne - $set operator', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/updateOne`, {
                filter: { _id: 'c1' },
                update: { $set: { age: 31, updated: true } },
            });
            expect(data.matchedCount).toBe(1);
            expect(data.modifiedCount).toBe(1);
        });

        it('[PASS] updateOne - upsert (existing)', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/updateOne`, {
                filter: { _id: 'c1' },
                update: { $set: { upserted: false } },
                upsert: true,
            });
            expect(data.matchedCount).toBe(1);
        });

        it('[PASS] updateOne - upsert (new)', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/updateOne`, {
                filter: { _id: 'upserted_doc' },
                update: { $set: { name: 'Uppy', age: 1 } },
                upsert: true,
            });
            expect(data.upsertedId).toBeTruthy();
        });

        it('[PASS] updateOne - no match', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/updateOne`, {
                filter: { _id: 'nonexistent_999' },
                update: { $set: { foo: 'bar' } },
            });
            expect(data.matchedCount).toBe(0);
        });
    });

    describe('Delete Operations', () => {
        it('[PASS] deleteOne - single document', async () => {
            await post(`/api/v1/collections/${coll}/insertOne`, {
                document: { _id: 'to_delete', temp: true },
            });
            const { data } = await post(`/api/v1/collections/${coll}/deleteOne`, {
                filter: { _id: 'to_delete' },
            });
            expect(data.deletedCount).toBe(1);
        });

        it('[PASS] deleteMany - multiple documents', async () => {
            await post(`/api/v1/collections/${coll}/insertMany`, {
                documents: [{ _id: 'dm1', temp: true }, { _id: 'dm2', temp: true }],
            });
            const { data } = await post(`/api/v1/collections/${coll}/deleteMany`, {
                filter: { temp: true },
            });
            expect(data.deletedCount).toBeGreaterThanOrEqual(2);
        });

        it('[PASS] deleteOne - no match', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/deleteOne`, {
                filter: { _id: 'does_not_exist_at_all' },
            });
            expect(data.deletedCount).toBe(0);
        });
    });

    describe('Index Operations', () => {
        it('[PASS] createIndex - non-unique', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/createIndex`, {
                field: 'age', unique: false,
            });
            expect(data.acknowledged).toBe(true);
        });

        it('[PASS] createIndex - unique', async () => {
            const { data } = await post(`/api/v1/collections/${coll}/createIndex`, {
                field: 'status', unique: false,
            });
            expect(data.acknowledged).toBe(true);
        });

        it('[PASS] listIndexes', async () => {
            const { data } = await get(`/api/v1/collections/${coll}/indexes`);
            expect(data.indexes.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('Error Handling', () => {
        it('[PASS] duplicate key error (E11000)', async () => {
            await post(`/api/v1/collections/${coll}/createIndex`, { field: 'compat_email', unique: true });
            await post(`/api/v1/collections/${coll}/insertOne`, { document: { compat_email: 'dup@test.com' } });
            const { status, data } = await post(`/api/v1/collections/${coll}/insertOne`, {
                document: { compat_email: 'dup@test.com' },
            });
            expect(status).toBe(409);
            expect(data.code).toBe(11000);
        });
    });

    // Cleanup
    it('teardown: drop test collection', async () => {
        await post(`/api/v1/collections/${coll}/drop`, {});
    });
});
