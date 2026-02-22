// PlugPort HTTP API Server
// Fastify-based REST API providing CRUD endpoints, index management, health checks, and metrics

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { timingSafeEqual } from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { DocumentStore, DocumentStoreError } from './storage/document-store.js';
import { MetricsCollector } from './metrics.js';
import { VERSION } from '@plugport/shared';
import type { Filter, Projection, SortSpec, KVAdapter } from '@plugport/shared';

export interface HttpServerOptions {
    port: number;
    host: string;
    apiKey?: string;
    store: DocumentStore;
    metrics: MetricsCollector;
    kvStore: KVAdapter & { getKeyCount(): number; getEstimatedSizeBytes(): number };
}

export async function createHttpServer(options: HttpServerOptions): Promise<FastifyInstance> {
    const { store, metrics, kvStore, apiKey } = options;

    const app = Fastify({
        bodyLimit: 52428800, // 50MB limit for bulk operations
        logger: {
            level: 'info',
            transport: {
                target: 'pino-pretty',
                options: { colorize: true, translateTime: 'HH:MM:ss' },
            },
        },
    });

    // Security Middleware
    await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });
    await app.register(rateLimit, {
        max: 100, // Limit each IP to 100 requests
        timeWindow: '10 seconds' // per 10 seconds (600 RPM)
    });

    // API Key middleware
    if (apiKey) {
        app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
            const path = request.url;
            if (path === '/health' || path === '/metrics' || path.startsWith('/api/v1/metrics')) return;

            const token = request.headers.authorization?.replace('Bearer ', '') ||
                request.headers['x-api-key'] as string;

            if (!token || !safeCompare(token, apiKey)) {
                reply.status(401).send({ ok: 0, code: 13, errmsg: 'Unauthorized' });
            }
        });
    }

    // Request timing
    app.addHook('onResponse', async (request, reply) => {
        const duration = reply.elapsedTime;
        const command = extractCommand(request.url, request.method);
        metrics.recordRequest(command, 'http', duration, reply.statusCode < 400);
    });

    // ---- Health & Metrics Endpoints ----

    app.get('/health', async () => {
        return {
            status: 'ok',
            uptime: process.uptime(),
            version: VERSION,
            storage: {
                type: 'monaddb-compatible',
                connected: true,
                keyCount: kvStore.getKeyCount(),
            },
            server: {
                httpPort: options.port,
                wirePort: 27017,
            },
        };
    });

    app.get('/metrics', async (_req, reply) => {
        const metricsText = await metrics.getPrometheusMetrics();
        reply.type(metrics.getContentType()).send(metricsText);
    });

    app.get('/api/v1/metrics', async () => {
        metrics.updateStorageMetrics(kvStore.getKeyCount(), kvStore.getEstimatedSizeBytes());
        return metrics.getSnapshot();
    });

    // ---- Collection Management ----

    app.get('/api/v1/collections', async () => {
        const collections = await store.listCollections();
        return {
            collections: collections.map((c) => ({
                name: c.name,
                documentCount: c.documentCount,
                indexCount: c.indexes.length,
                createdAt: c.options.createdAt,
            })),
            ok: 1,
        };
    });

    app.post('/api/v1/collections/:name/drop', async (req: FastifyRequest<{ Params: { name: string } }>) => {
        const dropped = await store.dropCollection(req.params.name);
        return { acknowledged: true, dropped, ok: 1 };
    });

    // ---- Insert ----

    app.post('/api/v1/collections/:name/insertOne', async (
        req: FastifyRequest<{ Params: { name: string }; Body: { document: Record<string, unknown> } }>,
        reply: FastifyReply,
    ) => {
        try {
            const result = await store.insert(req.params.name, [req.body.document]);
            return result;
        } catch (err) {
            return handleError(err, reply);
        }
    });

    app.post('/api/v1/collections/:name/insertMany', async (
        req: FastifyRequest<{ Params: { name: string }; Body: { documents: Record<string, unknown>[] } }>,
        reply: FastifyReply,
    ) => {
        try {
            const result = await store.insert(req.params.name, req.body.documents);
            return result;
        } catch (err) {
            return handleError(err, reply);
        }
    });

    // ---- Find ----

    app.post('/api/v1/collections/:name/find', async (
        req: FastifyRequest<{
            Params: { name: string };
            Body: { filter?: Filter; projection?: Projection; sort?: SortSpec; limit?: number; skip?: number };
        }>,
        reply: FastifyReply,
    ) => {
        try {
            const { filter = {}, projection, sort, limit, skip } = req.body || {};
            return store.find(req.params.name, filter, { projection, sort, limit, skip });
        } catch (err) {
            return handleError(err, reply);
        }
    });

    app.post('/api/v1/collections/:name/findOne', async (
        req: FastifyRequest<{
            Params: { name: string };
            Body: { filter?: Filter; projection?: Projection };
        }>,
    ) => {
        const { filter = {}, projection } = req.body || {};
        const result = await store.find(req.params.name, filter, { projection, limit: 1 });
        return {
            document: result.cursor.firstBatch[0] || null,
            ok: 1,
        };
    });

    // ---- Update ----

    app.post('/api/v1/collections/:name/updateOne', async (
        req: FastifyRequest<{
            Params: { name: string };
            Body: { filter: Filter; update: { $set?: Record<string, unknown>; $inc?: Record<string, number>; $unset?: Record<string, unknown> }; upsert?: boolean };
        }>,
        reply: FastifyReply,
    ) => {
        try {
            const { filter, update, upsert } = req.body;
            return store.updateOne(req.params.name, filter, update, { upsert });
        } catch (err) {
            return handleError(err, reply);
        }
    });

    app.post('/api/v1/collections/:name/updateMany', async (
        req: FastifyRequest<{
            Params: { name: string };
            Body: { filter: Filter; update: { $set?: Record<string, unknown>; $inc?: Record<string, number>; $unset?: Record<string, unknown> }; upsert?: boolean };
        }>,
        reply: FastifyReply,
    ) => {
        try {
            const { filter, update, upsert } = req.body;
            return store.updateMany(req.params.name, filter, update, { upsert });
        } catch (err) {
            return handleError(err, reply);
        }
    });

    // ---- Delete ----

    app.post('/api/v1/collections/:name/deleteOne', async (
        req: FastifyRequest<{
            Params: { name: string };
            Body: { filter: Filter };
        }>,
        reply: FastifyReply,
    ) => {
        try {
            return store.deleteOne(req.params.name, req.body.filter);
        } catch (err) {
            return handleError(err, reply);
        }
    });

    app.post('/api/v1/collections/:name/deleteMany', async (
        req: FastifyRequest<{
            Params: { name: string };
            Body: { filter: Filter };
        }>,
        reply: FastifyReply,
    ) => {
        try {
            return store.deleteMany(req.params.name, req.body.filter);
        } catch (err) {
            return handleError(err, reply);
        }
    });

    // ---- Index Management ----

    app.post('/api/v1/collections/:name/createIndex', async (
        req: FastifyRequest<{
            Params: { name: string };
            Body: { field: string; unique?: boolean };
        }>,
        reply: FastifyReply,
    ) => {
        try {
            return store.createIndex(req.params.name, req.body.field, req.body.unique);
        } catch (err) {
            return handleError(err, reply);
        }
    });

    app.post('/api/v1/collections/:name/dropIndex', async (
        req: FastifyRequest<{
            Params: { name: string };
            Body: { indexName: string };
        }>,
        reply: FastifyReply,
    ) => {
        try {
            const dropped = await store.dropIndex(req.params.name, req.body.indexName);
            return { acknowledged: true, dropped, ok: 1 };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    app.get('/api/v1/collections/:name/indexes', async (
        req: FastifyRequest<{ Params: { name: string } }>,
        reply: FastifyReply,
    ) => {
        try {
            const indexes = await store.listIndexes(req.params.name);
            return { indexes, ok: 1 };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    // ---- Collection Stats ----

    app.get('/api/v1/collections/:name/stats', async (
        req: FastifyRequest<{ Params: { name: string } }>,
        reply: FastifyReply,
    ) => {
        try {
            const stats = await store.getStats(req.params.name);
            return { ...stats, ok: 1 };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    // ---- Count & Distinct ----

    app.post('/api/v1/collections/:name/count', async (
        req: FastifyRequest<{
            Params: { name: string };
            Body: { filter?: Filter };
        }>,
        reply: FastifyReply,
    ) => {
        try {
            const { filter = {} } = req.body || {};
            const count = await store.countDocuments(req.params.name, filter);
            return { count, ok: 1 };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    app.post('/api/v1/collections/:name/distinct', async (
        req: FastifyRequest<{
            Params: { name: string };
            Body: { field: string; filter?: Filter };
        }>,
        reply: FastifyReply,
    ) => {
        try {
            const { field, filter = {} } = req.body || {} as { field: string; filter?: Filter };
            if (!field) {
                return reply.status(400).send({ ok: 0, errmsg: 'field is required' });
            }
            const result = await store.find(req.params.name, filter);
            const values = [...new Set(result.cursor.firstBatch.map((doc) => (doc as Record<string, unknown>)[field]))];
            return { values, ok: 1 };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    return app;
}

function extractCommand(url: string, method: string): string {
    if (url.includes('insertOne') || url.includes('insertMany')) return 'insert';
    if (url.includes('findOne') || url.includes('/find')) return 'find';
    if (url.includes('updateMany')) return 'updateMany';
    if (url.includes('updateOne')) return 'update';
    if (url.includes('deleteOne') || url.includes('deleteMany')) return 'delete';
    if (url.includes('createIndex') || url.includes('dropIndex')) return 'index';
    if (url.includes('/count')) return 'count';
    if (url.includes('/distinct')) return 'distinct';
    if (url.includes('health')) return 'health';
    if (url.includes('metrics')) return 'metrics';
    if (url.includes('collections')) return 'listCollections';
    return `${method.toLowerCase()}:unknown`;
}

function handleError(err: unknown, reply: FastifyReply) {
    if (err instanceof DocumentStoreError) {
        const status = err.code === 11000 ? 409 : 400;
        return reply.status(status).send({
            ok: 0,
            code: err.code,
            errmsg: err.message,
            codeName: err.codeName,
        });
    }
    return reply.status(500).send({
        ok: 0,
        code: 1,
        errmsg: err instanceof Error ? err.message : 'Internal server error',
    });
}

/**
 * Constant-time string comparison to prevent timing attacks on API keys.
 */
function safeCompare(a: string, b: string): boolean {
    try {
        const bufA = Buffer.from(a, 'utf-8');
        const bufB = Buffer.from(b, 'utf-8');
        if (bufA.length !== bufB.length) {
            // Compare against self to keep timing constant, then return false
            timingSafeEqual(bufA, bufA);
            return false;
        }
        return timingSafeEqual(bufA, bufB);
    } catch {
        return false;
    }
}
