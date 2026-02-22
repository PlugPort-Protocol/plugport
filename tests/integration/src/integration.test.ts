// PlugPort HTTP API Integration Tests
// E2E tests against a live PlugPort server

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

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

describe('HTTP API Integration Tests', () => {
    const testCollection = `test_integration_${Date.now()}`;

    afterAll(async () => {
        // Cleanup
        await post(`/api/v1/collections/${testCollection}/drop`, {});
    });

    describe('Health', () => {
        it('should return health status', async () => {
            const { status, data } = await get('/health');
            expect(status).toBe(200);
            expect(data.status).toBe('ok');
            expect(data.version).toBeTruthy();
        });
    });

    describe('InsertOne', () => {
        it('should insert a document', async () => {
            const { status, data } = await post(`/api/v1/collections/${testCollection}/insertOne`, {
                document: { name: 'Alice', email: 'alice@test.com', age: 30 },
            });
            expect(status).toBe(200);
            expect(data.acknowledged).toBe(true);
            expect(data.insertedId).toBeTruthy();
        });

        it('should auto-generate _id', async () => {
            const { data } = await post(`/api/v1/collections/${testCollection}/insertOne`, {
                document: { name: 'Bob' },
            });
            expect(data.insertedId).toBeTruthy();
            expect(data.insertedId.length).toBe(24);
        });

        it('should use provided _id', async () => {
            const { data } = await post(`/api/v1/collections/${testCollection}/insertOne`, {
                document: { _id: 'custom-id', name: 'Custom' },
            });
            expect(data.insertedId).toBe('custom-id');
        });
    });

    describe('InsertMany', () => {
        it('should insert multiple documents', async () => {
            const { data } = await post(`/api/v1/collections/${testCollection}/insertMany`, {
                documents: [
                    { name: 'Charlie', age: 25 },
                    { name: 'Diana', age: 35 },
                    { name: 'Eve', age: 28 },
                ],
            });
            expect(data.insertedCount).toBe(3);
        });
    });

    describe('Find', () => {
        it('should find all documents', async () => {
            const { data } = await post(`/api/v1/collections/${testCollection}/find`, {
                filter: {},
            });
            expect(data.cursor.firstBatch.length).toBeGreaterThan(0);
            expect(data.ok).toBe(1);
        });

        it('should filter by exact match', async () => {
            const { data } = await post(`/api/v1/collections/${testCollection}/find`, {
                filter: { name: 'Alice' },
            });
            expect(data.cursor.firstBatch.length).toBe(1);
            expect(data.cursor.firstBatch[0].name).toBe('Alice');
        });

        it('should filter by range', async () => {
            const { data } = await post(`/api/v1/collections/${testCollection}/find`, {
                filter: { age: { $gte: 30 } },
            });
            const ages = data.cursor.firstBatch.map((d: Record<string, unknown>) => d.age);
            expect(ages.every((a: number) => a >= 30)).toBe(true);
        });

        it('should apply limit', async () => {
            const { data } = await post(`/api/v1/collections/${testCollection}/find`, {
                filter: {}, limit: 2,
            });
            expect(data.cursor.firstBatch.length).toBeLessThanOrEqual(2);
        });

        it('should apply projection', async () => {
            const { data } = await post(`/api/v1/collections/${testCollection}/find`, {
                filter: { name: 'Alice' },
                projection: { name: 1 },
            });
            const doc = data.cursor.firstBatch[0];
            expect(doc.name).toBe('Alice');
            expect(doc.email).toBeUndefined();
        });
    });

    describe('FindOne', () => {
        it('should find one document', async () => {
            const { data } = await post(`/api/v1/collections/${testCollection}/findOne`, {
                filter: { name: 'Alice' },
            });
            expect(data.document).toBeTruthy();
            expect(data.document.name).toBe('Alice');
        });

        it('should return null for no match', async () => {
            const { data } = await post(`/api/v1/collections/${testCollection}/findOne`, {
                filter: { name: 'Nonexistent' },
            });
            expect(data.document).toBeNull();
        });
    });

    describe('UpdateOne', () => {
        it('should update a document', async () => {
            const { data } = await post(`/api/v1/collections/${testCollection}/updateOne`, {
                filter: { name: 'Alice' },
                update: { $set: { age: 31, updated: true } },
            });
            expect(data.matchedCount).toBe(1);
            expect(data.modifiedCount).toBe(1);

            // Verify
            const { data: found } = await post(`/api/v1/collections/${testCollection}/findOne`, {
                filter: { name: 'Alice' },
            });
            expect(found.document.age).toBe(31);
            expect(found.document.updated).toBe(true);
        });
    });

    describe('DeleteOne', () => {
        it('should delete a document', async () => {
            const { data } = await post(`/api/v1/collections/${testCollection}/deleteOne`, {
                filter: { _id: 'custom-id' },
            });
            expect(data.acknowledged).toBe(true);
            expect(data.deletedCount).toBe(1);
        });
    });

    describe('Indexes', () => {
        it('should create an index', async () => {
            const { data } = await post(`/api/v1/collections/${testCollection}/createIndex`, {
                field: 'email', unique: true,
            });
            expect(data.acknowledged).toBe(true);
            expect(data.indexName).toBe('email_1');
        });

        it('should list indexes', async () => {
            const { data } = await get(`/api/v1/collections/${testCollection}/indexes`);
            expect(data.indexes.length).toBeGreaterThanOrEqual(2);
        });

        it('should enforce unique index', async () => {
            await post(`/api/v1/collections/${testCollection}/insertOne`, {
                document: { email: 'unique@test.com', name: 'UniqueUser' },
            });
            const { status, data } = await post(`/api/v1/collections/${testCollection}/insertOne`, {
                document: { email: 'unique@test.com', name: 'DuplicateUser' },
            });
            expect(status).toBe(409);
            expect(data.code).toBe(11000);
        });
    });

    describe('Collections listing', () => {
        it('should list collections', async () => {
            const { data } = await get('/api/v1/collections');
            expect(data.collections).toBeInstanceOf(Array);
            const names = data.collections.map((c: Record<string, unknown>) => c.name);
            expect(names).toContain(testCollection);
        });
    });

    describe('Metrics', () => {
        it('should return metrics snapshot', async () => {
            const { data } = await get('/api/v1/metrics');
            expect(data.requests).toBeTruthy();
            expect(data.latency).toBeTruthy();
            expect(data.uptime).toBeGreaterThan(0);
        });
    });
});
