// k6 Load Test for PlugPort
// Tests CRUD mix at various concurrency levels
//
// Run with: k6 run tests/load/crud-mix.js
//
// Environment variables:
//   PLUGPORT_URL - default: http://localhost:8080

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.PLUGPORT_URL || 'http://localhost:8080';

const errorRate = new Rate('errors');
const insertLatency = new Trend('insert_latency', true);
const findLatency = new Trend('find_latency', true);
const updateLatency = new Trend('update_latency', true);
const deleteLatency = new Trend('delete_latency', true);

export const options = {
    stages: [
        { duration: '10s', target: 10 },   // Ramp up to 10 users
        { duration: '30s', target: 50 },   // Ramp up to 50 users
        { duration: '60s', target: 100 },  // Sustained 100 users
        { duration: '30s', target: 200 },  // Peak at 200 users
        { duration: '20s', target: 50 },   // Cool down
        { duration: '10s', target: 0 },    // Ramp down
    ],
    thresholds: {
        http_req_failed: ['rate<0.05'],        // <5% errors
        http_req_duration: ['p(95)<500'],      // P95 < 500ms
        insert_latency: ['p(95)<200'],         // Insert P95 < 200ms
        find_latency: ['p(95)<100'],           // Find P95 < 100ms
        errors: ['rate<0.05'],
    },
};

const headers = { 'Content-Type': 'application/json' };

export function setup() {
    // Create test collection with indexes
    const coll = `loadtest_${Date.now()}`;
    http.post(`${BASE_URL}/api/v1/collections/${coll}/createIndex`, JSON.stringify({
        field: 'userId', unique: false,
    }), { headers });
    return { collection: coll };
}

export default function (data) {
    const coll = data.collection;
    const userId = `user_${__VU}_${__ITER}`;

    group('Insert', () => {
        const start = Date.now();
        const res = http.post(
            `${BASE_URL}/api/v1/collections/${coll}/insertOne`,
            JSON.stringify({
                document: {
                    userId,
                    name: `User ${__VU}`,
                    email: `${userId}@loadtest.com`,
                    age: Math.floor(Math.random() * 50) + 18,
                    score: Math.random() * 100,
                    createdAt: new Date().toISOString(),
                },
            }),
            { headers }
        );
        insertLatency.add(Date.now() - start);

        const ok = check(res, {
            'insert status 200': (r) => r.status === 200,
            'insert acknowledged': (r) => JSON.parse(r.body).acknowledged === true,
        });
        errorRate.add(!ok);
    });

    sleep(0.1);

    group('Find', () => {
        const start = Date.now();
        const res = http.post(
            `${BASE_URL}/api/v1/collections/${coll}/find`,
            JSON.stringify({ filter: { userId }, limit: 10 }),
            { headers }
        );
        findLatency.add(Date.now() - start);

        check(res, {
            'find status 200': (r) => r.status === 200,
            'find has results': (r) => JSON.parse(r.body).cursor.firstBatch.length > 0,
        });
    });

    sleep(0.1);

    group('Update', () => {
        const start = Date.now();
        const res = http.post(
            `${BASE_URL}/api/v1/collections/${coll}/updateOne`,
            JSON.stringify({
                filter: { userId },
                update: { $set: { score: Math.random() * 100, updatedAt: new Date().toISOString() } },
            }),
            { headers }
        );
        updateLatency.add(Date.now() - start);

        check(res, {
            'update status 200': (r) => r.status === 200,
        });
    });

    sleep(0.1);

    // Occasionally delete (10% of iterations)
    if (Math.random() < 0.1) {
        group('Delete', () => {
            const start = Date.now();
            const res = http.post(
                `${BASE_URL}/api/v1/collections/${coll}/deleteOne`,
                JSON.stringify({ filter: { userId } }),
                { headers }
            );
            deleteLatency.add(Date.now() - start);

            check(res, {
                'delete status 200': (r) => r.status === 200,
            });
        });
    }

    sleep(0.2);
}

export function teardown(data) {
    // Cleanup
    http.post(`${BASE_URL}/api/v1/collections/${data.collection}/drop`, JSON.stringify({}), { headers });
}
