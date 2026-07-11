// PlugPort Aggregation Pipeline Integration Tests
// E2E tests for $lookup, $match, $project, $sort, $limit, $skip, $unwind, $count

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const API_BASE = process.env.PLUGPORT_URL || 'http://localhost:8080';

async function post(path: string, body: unknown) {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() as Record<string, any> };
}

describe('Aggregation Pipeline Tests', () => {
    const usersCol = `test_agg_users_${Date.now()}`;
    const ordersCol = `test_agg_orders_${Date.now()}`;

    beforeAll(async () => {
        // Seed users
        await post(`/api/v1/collections/${usersCol}/insert`, {
            documents: [
                { _id: 'user_1', name: 'Alice', age: 30, role: 'admin' },
                { _id: 'user_2', name: 'Bob', age: 25, role: 'user' },
                { _id: 'user_3', name: 'Charlie', age: 35, role: 'user' },
            ],
        });

        // Seed orders
        await post(`/api/v1/collections/${ordersCol}/insert`, {
            documents: [
                { _id: 'order_1', userId: 'user_1', total: 99.99, status: 'completed', items: ['item_a', 'item_b'] },
                { _id: 'order_2', userId: 'user_1', total: 49.99, status: 'pending', items: ['item_c'] },
                { _id: 'order_3', userId: 'user_2', total: 150.00, status: 'completed', items: ['item_a'] },
                { _id: 'order_4', userId: 'user_3', total: 25.00, status: 'completed', items: ['item_b', 'item_c', 'item_d'] },
            ],
        });
    });

    afterAll(async () => {
        await post(`/api/v1/collections/${usersCol}/drop`, {});
        await post(`/api/v1/collections/${ordersCol}/drop`, {});
    });

    // ---- $match ----

    it('$match: filters documents', async () => {
        const { data } = await post(`/api/v1/collections/${ordersCol}/aggregate`, {
            pipeline: [{ $match: { status: 'completed' } }],
        });
        expect(data.ok).toBe(1);
        expect(data.cursor.firstBatch).toHaveLength(3);
        data.cursor.firstBatch.forEach((doc: any) => {
            expect(doc.status).toBe('completed');
        });
    });

    // ---- $project ----

    it('$project: includes only specified fields', async () => {
        const { data } = await post(`/api/v1/collections/${usersCol}/aggregate`, {
            pipeline: [{ $project: { name: 1, age: 1, _id: 0 } }],
        });
        expect(data.ok).toBe(1);
        data.cursor.firstBatch.forEach((doc: any) => {
            expect(doc).toHaveProperty('name');
            expect(doc).toHaveProperty('age');
            expect(doc).not.toHaveProperty('_id');
            expect(doc).not.toHaveProperty('role');
        });
    });

    it('$project: excludes specified fields', async () => {
        const { data } = await post(`/api/v1/collections/${usersCol}/aggregate`, {
            pipeline: [{ $project: { role: 0 } }],
        });
        expect(data.ok).toBe(1);
        data.cursor.firstBatch.forEach((doc: any) => {
            expect(doc).not.toHaveProperty('role');
            expect(doc).toHaveProperty('name');
        });
    });

    // ---- $sort ----

    it('$sort: sorts ascending and descending', async () => {
        const { data } = await post(`/api/v1/collections/${ordersCol}/aggregate`, {
            pipeline: [{ $sort: { total: -1 } }],
        });
        expect(data.ok).toBe(1);
        const totals = data.cursor.firstBatch.map((d: any) => d.total);
        for (let i = 0; i < totals.length - 1; i++) {
            expect(totals[i]).toBeGreaterThanOrEqual(totals[i + 1]);
        }
    });

    // ---- $limit ----

    it('$limit: limits result count', async () => {
        const { data } = await post(`/api/v1/collections/${ordersCol}/aggregate`, {
            pipeline: [{ $limit: 2 }],
        });
        expect(data.ok).toBe(1);
        expect(data.cursor.firstBatch).toHaveLength(2);
    });

    // ---- $skip ----

    it('$skip: skips documents', async () => {
        const { data } = await post(`/api/v1/collections/${ordersCol}/aggregate`, {
            pipeline: [{ $skip: 2 }],
        });
        expect(data.ok).toBe(1);
        expect(data.cursor.firstBatch).toHaveLength(2); // 4 total - 2 skipped
    });

    // ---- $count ----

    it('$count: counts documents', async () => {
        const { data } = await post(`/api/v1/collections/${ordersCol}/aggregate`, {
            pipeline: [
                { $match: { status: 'completed' } },
                { $count: 'completedOrders' },
            ],
        });
        expect(data.ok).toBe(1);
        expect(data.cursor.firstBatch).toHaveLength(1);
        expect(data.cursor.firstBatch[0].completedOrders).toBe(3);
    });

    // ---- $unwind ----

    it('$unwind: flattens arrays', async () => {
        const { data } = await post(`/api/v1/collections/${ordersCol}/aggregate`, {
            pipeline: [
                { $match: { _id: 'order_4' } },
                { $unwind: '$items' },
            ],
        });
        expect(data.ok).toBe(1);
        // order_4 has 3 items, so $unwind should produce 3 documents
        expect(data.cursor.firstBatch).toHaveLength(3);
        data.cursor.firstBatch.forEach((doc: any) => {
            expect(typeof doc.items).toBe('string'); // Each unwound item is a string, not array
        });
    });

    // ---- $lookup ----

    it('$lookup: joins collections', async () => {
        const { data } = await post(`/api/v1/collections/${ordersCol}/aggregate`, {
            pipeline: [
                { $match: { userId: 'user_1' } },
                { $lookup: {
                    from: usersCol,
                    localField: 'userId',
                    foreignField: '_id',
                    as: 'user',
                }},
            ],
        });
        expect(data.ok).toBe(1);
        expect(data.cursor.firstBatch.length).toBeGreaterThanOrEqual(1);

        // Each order should have a 'user' array with Alice's doc
        data.cursor.firstBatch.forEach((doc: any) => {
            expect(doc.user).toBeInstanceOf(Array);
            expect(doc.user.length).toBe(1);
            expect(doc.user[0].name).toBe('Alice');
        });
    });

    // ---- Combined Pipeline ----

    it('combined pipeline: $match → $lookup → $sort → $limit', async () => {
        const { data } = await post(`/api/v1/collections/${ordersCol}/aggregate`, {
            pipeline: [
                { $match: { status: 'completed' } },
                { $lookup: {
                    from: usersCol,
                    localField: 'userId',
                    foreignField: '_id',
                    as: 'buyer',
                }},
                { $sort: { total: -1 } },
                { $limit: 2 },
            ],
        });
        expect(data.ok).toBe(1);
        expect(data.cursor.firstBatch).toHaveLength(2);

        // Should be sorted by total descending
        expect(data.cursor.firstBatch[0].total).toBeGreaterThanOrEqual(data.cursor.firstBatch[1].total);

        // Should have buyer lookup
        data.cursor.firstBatch.forEach((doc: any) => {
            expect(doc.buyer).toBeInstanceOf(Array);
            expect(doc.buyer.length).toBe(1);
        });
    });

    // ---- Empty Pipeline ----

    it('empty pipeline: returns all documents', async () => {
        const { data } = await post(`/api/v1/collections/${usersCol}/aggregate`, {
            pipeline: [],
        });
        expect(data.ok).toBe(1);
        expect(data.cursor.firstBatch).toHaveLength(3);
    });
});
