// PlugPort HTTP API Server
// Fastify-based REST API providing CRUD endpoints, auth, API key management,
// per-collection privacy, analytics, and protocol management.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { timingSafeEqual, randomBytes } from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getIronSession } from 'iron-session';
import { SiweMessage, generateNonce as siweGenerateNonce } from 'siwe';
import { DocumentStore, DocumentStoreError } from './storage/document-store.js';
import { MetricsCollector } from './metrics.js';
import { getSessionOptions, type SessionData } from './auth/session.js';
import { ApiKeyManager, type ApiKeyPermission } from './auth/api-key-manager.js';
import { AnalyticsRecorder } from './auth/analytics-recorder.js';
import { PrivacyManager } from './storage/privacy-manager.js';
import { SQLTranslator } from './protocols/sql-translator.js';
import type { TranslatedQuery } from './protocols/sql-translator.js';
import { parseRESP } from './protocols/redis-server.js';
import type { RedisServer } from './protocols/redis-server.js';
import { VERSION } from '@plugport/shared';
import type { Filter, Projection, SortSpec, KVAdapter } from '@plugport/shared';

// ---- Request User Decoration ----

declare module 'fastify' {
    interface FastifyRequest {
        user?: {
            address?: string;
            authMethod: 'wallet' | 'apiKey' | 'legacyKey' | 'none';
            keyHash?: string;
        };
    }
}

export interface HttpServerOptions {
    port: number;
    host: string;
    apiKey?: string;
    store: DocumentStore;
    metrics: MetricsCollector;
    kvStore: KVAdapter & { getKeyCount(): number; getEstimatedSizeBytes(): number };
    protocolManager?: {
        getStatus(): Array<{ name: string; enabled: boolean; port: number; connections: number; connectionString: string }>;
        enableProtocol(name: string): Promise<void>;
        disableProtocol(name: string): Promise<void>;
    };
    whitelistAddresses?: string[];
    /** Allowed origin for CORS credentials (defaults to DASHBOARD_URL env var) */
    dashboardUrl?: string;
}

export async function createHttpServer(options: HttpServerOptions): Promise<FastifyInstance> {
    const { store, metrics, kvStore, apiKey } = options;

    // Initialize auth subsystems
    const sessionOptions = getSessionOptions();
    const apiKeyManager = new ApiKeyManager(kvStore);
    const analyticsRecorder = new AnalyticsRecorder(kvStore);
    const privacyManager = new PrivacyManager(kvStore);
    if ('setPrivacyManager' in kvStore && typeof kvStore.setPrivacyManager === 'function') {
        kvStore.setPrivacyManager(privacyManager);
    }

    const app = Fastify({
        bodyLimit: 52428800, // 50MB limit for bulk operations
        logger: process.env.NODE_ENV === 'production'
            ? { level: 'info' } // JSON logs for production (Railway, Docker, etc.)
            : {
                level: 'info',
                transport: {
                    target: 'pino-pretty',
                    options: { colorize: true, translateTime: 'HH:MM:ss' },
                },
            },
    });

    // Security Middleware
    const allowedOrigin = options.dashboardUrl
        || process.env.DASHBOARD_URL
        || (process.env.NODE_ENV === 'production' ? undefined : true);
    await app.register(cors, {
        origin: allowedOrigin,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    });
    await app.register(cookie);
    await app.register(rateLimit, {
        max: 100, // Limit each IP to 100 requests
        timeWindow: '10 seconds' // per 10 seconds (600 RPM)
    });

    // ---- Triple-Auth Middleware ----
    // Priority: (1) Session cookie → wallet auth (SIWE), (2) pp_live_/pp_test_ → wallet-linked API key,
    //           (3) legacy x-api-key → static API key from .env
    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        const path = request.url;

        // Public endpoints — no auth required
        if (path === '/health' || path === '/metrics' || path.startsWith('/api/v1/metrics')
            || path.startsWith('/api/v1/auth/')) {
            request.user = { authMethod: 'none' };
            return;
        }

        // Test backdoor for integration tests
        if (process.env.NODE_ENV !== 'production' && request.headers['x-test-wallet-address']) {
            request.user = { address: request.headers['x-test-wallet-address'] as string, authMethod: 'wallet' };
            return;
        }

        // Method 1: Session cookie (wallet auth via SIWE)
        try {
            const session = await getIronSession<SessionData>(request.raw, reply.raw, sessionOptions);
            if (session.address) {
                request.user = { address: session.address, authMethod: 'wallet' };

                // CSRF validation for state-changing requests (session-authed only)
                const method = request.method;
                if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
                    const csrfHeader = request.headers['x-csrf-token'] as string;
                    if (!session.csrfToken || csrfHeader !== session.csrfToken) {
                        return reply.status(403).send({ ok: 0, errmsg: 'CSRF token missing or invalid' });
                    }
                }
                return;
            }
        } catch (err) {
            // Cookie missing or corrupt — fall through to other methods
            if (process.env.LOG_LEVEL === 'debug') {
                console.warn('[Auth] Session cookie parse failed:', err instanceof Error ? err.message : 'unknown');
            }
        }

        const authHeader = request.headers.authorization;
        const xApiKey = request.headers['x-api-key'] as string;

        // Method 2: Wallet-linked API key (pp_live_... or pp_test_...)
        // API key auth does NOT require CSRF tokens (no cookie-based session)
        const rawKey = xApiKey || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined);
        if (rawKey?.startsWith('pp_')) {
            const validation = await apiKeyManager.validateKey(rawKey);
            if (validation.valid) {
                request.user = {
                    address: validation.ownerAddress,
                    authMethod: 'apiKey',
                    keyHash: validation.hash,
                };
                return;
            }
            return reply.status(401).send({ ok: 0, code: 13, errmsg: 'Invalid or revoked API key' });
        }

        // Method 3: Legacy static API key from .env
        if (apiKey) {
            const token = rawKey || xApiKey;
            if (token && safeCompare(token, apiKey)) {
                request.user = { authMethod: 'legacyKey' };
                return;
            }
            return reply.status(401).send({ ok: 0, code: 13, errmsg: 'Unauthorized' });
        }

        // No auth configured — open access (dev mode)
        request.user = { authMethod: 'none' };
    });

    // Request timing + API key analytics
    app.addHook('onResponse', async (request, reply) => {
        const duration = reply.elapsedTime;
        const command = extractCommand(request.url, request.method);
        metrics.recordRequest(command, 'http', duration, reply.statusCode < 400);

        // Record per-key analytics if authenticated via wallet-linked API key
        if (request.user?.authMethod === 'apiKey' && request.user.keyHash) {
            const collection = extractCollection(request.url);
            analyticsRecorder.record(request.user.keyHash, {
                operation: command,
                collection: collection || undefined,
                latencyMs: duration,
                statusCode: reply.statusCode,
                payloadBytes: parseInt(reply.getHeader('content-length') as string || '0', 10),
            }).catch((err) => {
                if (process.env.LOG_LEVEL === 'debug') {
                    console.warn('[Analytics] Record failed:', err instanceof Error ? err.message : 'unknown');
                }
            }); // Fire-and-forget, don't block response
        }
    });

    // ---- Health & Metrics Endpoints ----

    app.get('/health', async () => {
        const result: Record<string, unknown> = {
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
            cryptoEnabled: 'setPrivacyManager' in kvStore,
        };
        if (options.protocolManager) {
            result.protocols = options.protocolManager.getStatus();
        }
        return result;
    });

    app.get('/metrics', async (_req, reply) => {
        const metricsText = await metrics.getPrometheusMetrics();
        reply.type(metrics.getContentType()).send(metricsText);
    });

    app.get('/api/v1/metrics', async () => {
        metrics.updateStorageMetrics(kvStore.getKeyCount(), kvStore.getEstimatedSizeBytes());
        return metrics.getSnapshot();
    });

    // ---- Access Control Helper ----

    async function checkAccess(req: FastifyRequest, reply: FastifyReply, collection: string, type: 'read' | 'write'): Promise<boolean> {
        // If no user address is known (e.g., authMethod='none' or 'legacyKey'), we allow public access 
        // OR we can strictly enforce it if privacy mode is private. 
        // privacyManager.hasAccess handles public/private fallback.
        const address = req.user?.address;
        
        let hasAccess = false;
        if (type === 'read') {
            hasAccess = await privacyManager.hasReadAccess(collection, address || '');
        } else {
            hasAccess = await privacyManager.hasWriteAccess(collection, address || '');
        }

        if (!hasAccess) {
            reply.status(403).send({ ok: 0, errmsg: `Access denied: insufficient ${type} privileges for collection ${collection}` });
            return false;
        }
        return true;
    }

    // ---- Collection Management ----

    app.get('/api/v1/collections', async () => {
        const collections = await store.listCollections();
        const mappedCollections = await Promise.all(collections.map(async (c) => {
            const privacy = await privacyManager.getCollectionPrivacy(c.name);
            return {
                name: c.name,
                documentCount: c.documentCount,
                indexCount: c.indexes.length,
                createdAt: c.options.createdAt,
                ownerAddress: privacy?.ownerAddress,
                mode: privacy?.mode || 'public',
            };
        }));
        return { collections: mappedCollections, ok: 1 };
    });

    app.post('/api/v1/collections/:name/drop', async (req: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
        const dropped = await store.dropCollection(req.params.name);
        return { acknowledged: true, dropped, ok: 1 };
    });

    // ---- Insert ----

    app.post('/api/v1/collections/:name/insertOne', async (
        req: FastifyRequest<{ Params: { name: string }; Body: { document: Record<string, unknown> } }>,
        reply: FastifyReply,
    ) => {
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
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
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
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
        if (!(await checkAccess(req, reply, req.params.name, 'read'))) return;
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
        reply: FastifyReply,
    ) => {
        if (!(await checkAccess(req, reply, req.params.name, 'read'))) return;
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
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
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
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
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
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
        try {
            const { filter } = req.body;
            return store.deleteOne(req.params.name, filter);
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
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
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
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
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
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
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
        if (!(await checkAccess(req, reply, req.params.name, 'read'))) return;
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
        if (!(await checkAccess(req, reply, req.params.name, 'read'))) return;
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
        if (!(await checkAccess(req, reply, req.params.name, 'read'))) return;
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
        if (!(await checkAccess(req, reply, req.params.name, 'read'))) return;
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

    // ---- Protocol Management Endpoints ----

    app.get('/api/v1/protocols', async () => {
        if (!options.protocolManager) {
            return { protocols: [], ok: 1 };
        }
        return { protocols: options.protocolManager.getStatus(), ok: 1 };
    });

    // ---- SQL Endpoint ----

    app.post('/api/v1/sql', async (
        req: FastifyRequest<{ Body: { query: string; params?: any[] } }>,
        reply: FastifyReply,
    ) => {
        try {
            const { query } = req.body;
            if (!query) return reply.status(400).send({ ok: 0, errmsg: 'query required' });

            const translator = new SQLTranslator();
            const translated = translator.translate(query) as TranslatedQuery;

            if (translated.type === 'noop') {
                return { ok: 1, message: translated.message };
            }

            if (translated.type === 'use') {
                return { ok: 1, message: translated.message };
            }

            let result;
            if (!translated.collection && translated.type !== 'showDatabases') {
                return reply.status(400).send({ ok: 0, errmsg: 'collection required' });
            }
            const collection = translated.collection as string;

            switch (translated.type) {
                case 'find': {
                    if (!(await checkAccess(req, reply, collection, 'read'))) return;
                    result = await store.find(collection, translated.filter || {}, {
                        projection: translated.projection,
                        sort: translated.sort,
                        limit: translated.limit,
                        skip: translated.skip,
                    });
                    break;
                }
                case 'insert': {
                    if (!(await checkAccess(req, reply, collection, 'write'))) return;
                    result = await store.insert(collection, translated.documents || []);
                    break;
                }
                case 'update': {
                    if (!(await checkAccess(req, reply, collection, 'write'))) return;
                    result = translated.multi
                        ? await store.updateMany(collection, translated.filter || {}, translated.update || {})
                        : await store.updateOne(collection, translated.filter || {}, translated.update || {});
                    break;
                }
                case 'delete': {
                    if (!(await checkAccess(req, reply, collection, 'write'))) return;
                    result = translated.multi
                        ? await store.deleteMany(collection, translated.filter || {})
                        : await store.deleteOne(collection, translated.filter || {});
                    break;
                }
                case 'createIndex': {
                    if (!(await checkAccess(req, reply, collection, 'write'))) return;
                    if (!translated.indexField) return reply.status(400).send({ ok: 0, errmsg: 'indexField required' });
                    result = await store.createIndex(collection, translated.indexField, translated.indexUnique || false);
                    break;
                }
                case 'dropIndex': {
                    if (!(await checkAccess(req, reply, collection, 'write'))) return;
                    if (!translated.indexName) return reply.status(400).send({ ok: 0, errmsg: 'indexName required' });
                    result = await store.dropIndex(collection, translated.indexName);
                    break;
                }
                default:
                    return reply.status(400).send({ ok: 0, errmsg: `unsupported operation: ${(translated as any).type}` });
            }

            return { ok: 1, result };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    // ---- Redis Endpoint ----

    app.post('/api/v1/redis', async (
        req: FastifyRequest<{ Body: { command: string[] } }>,
        reply: FastifyReply,
    ) => {
        try {
            const { command } = req.body;
            if (!command || !Array.isArray(command) || command.length === 0) {
                return reply.status(400).send({ ok: 0, errmsg: 'command array required' });
            }

            const pm = options.protocolManager as any;
            if (!pm) {
                return reply.status(500).send({ ok: 0, errmsg: 'protocol manager not active' });
            }

            const redisServer = pm.getProtocol ? pm.getProtocol('redis') : null;
            if (!redisServer) {
                return reply.status(500).send({ ok: 0, errmsg: 'redis protocol not active' });
            }
            
            let outputBuffer = Buffer.alloc(0);
            const fakeSocket = {
                write: (data: Buffer) => {
                    outputBuffer = Buffer.concat([outputBuffer, data]);
                },
                end: () => {},
                destroyed: false,
            };

            await redisServer.executeCommand(fakeSocket as any, command);

            const parsed = parseRESP(outputBuffer);
            
            // Map RESPValue to standard JS
            function mapResp(resp: any): any {
                if (!resp) return null;
                if (resp.type === 'error') throw new Error(resp.value);
                if (resp.type === 'array') return resp.value.map(mapResp);
                return resp.value;
            }

            return { ok: 1, result: parsed ? mapResp(parsed.value) : null };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    app.get('/api/v1/redis/stream', async (
        req: FastifyRequest<{ Querystring: { channels: string } }>,
        reply: FastifyReply,
    ) => {
        const channels = req.query.channels?.split(',') || [];
        if (channels.length === 0) return reply.status(400).send({ ok: 0, errmsg: 'channels required' });

        const pm = options.protocolManager as any;
        const redisServer = pm?.getProtocol ? pm.getProtocol('redis') as RedisServer : null;
        if (!redisServer) return reply.status(500).send({ ok: 0, errmsg: 'redis protocol not active' });

        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        // CORS headers
        reply.raw.setHeader('Access-Control-Allow-Origin', '*');

        let destroyed = false;

        const fakeSocket = {
            write: (data: Buffer) => {
                if (destroyed) return;
                try {
                    const parsed = parseRESP(data);
                    if (parsed && parsed.value && typeof parsed.value === 'object' && parsed.value.type === 'array') {
                        const arr = (parsed.value.value as any[]).map(v => v.value);
                        if (arr[0] === 'message') {
                            reply.raw.write(`data: ${JSON.stringify({ channel: arr[1], message: arr[2] })}\n\n`);
                        } else {
                            reply.raw.write(`data: ${JSON.stringify({ event: arr[0], channel: arr[1], count: arr[2] })}\n\n`);
                        }
                    }
                } catch (err) {
                    // ignore parse errors for partial chunks
                }
            },
            end: () => { destroyed = true; reply.raw.end(); },
            get destroyed() { return destroyed; }
        };

        await redisServer.executeCommand(fakeSocket as any, ['SUBSCRIBE', ...channels]);

        req.raw.on('close', () => {
            destroyed = true;
            redisServer.executeCommand(fakeSocket as any, ['UNSUBSCRIBE', ...channels]).catch(() => {});
        });
        
        reply.hijack();
    });

    app.post('/api/v1/protocols/:name/enable', async (
        req: FastifyRequest<{ Params: { name: string } }>,
        reply: FastifyReply,
    ) => {
        if (!options.protocolManager) {
            return reply.status(501).send({ ok: 0, errmsg: 'Protocol manager not available' });
        }
        try {
            await options.protocolManager.enableProtocol(req.params.name);
            return { ok: 1, protocol: req.params.name, enabled: true };
        } catch (err) {
            return reply.status(400).send({ ok: 0, errmsg: err instanceof Error ? err.message : 'Failed' });
        }
    });

    app.post('/api/v1/protocols/:name/disable', async (
        req: FastifyRequest<{ Params: { name: string } }>,
        reply: FastifyReply,
    ) => {
        if (!options.protocolManager) {
            return reply.status(501).send({ ok: 0, errmsg: 'Protocol manager not available' });
        }
        try {
            await options.protocolManager.disableProtocol(req.params.name);
            return { ok: 1, protocol: req.params.name, enabled: false };
        } catch (err) {
            return reply.status(400).send({ ok: 0, errmsg: err instanceof Error ? err.message : 'Failed' });
        }
    });

    // ---- Whitelist Management (Legacy — global, persisted to KV) ----

    const WHITELIST_KEY = 'meta:whitelist:global';

    async function getWhitelist(): Promise<string[]> {
        const raw = await kvStore.get(WHITELIST_KEY);
        if (raw) {
            try { return JSON.parse(raw.toString()); } catch { /* ignore malformed */ }
        }
        return options.whitelistAddresses || [];
    }

    async function saveWhitelist(addresses: string[]): Promise<void> {
        await kvStore.put(WHITELIST_KEY, Buffer.from(JSON.stringify(addresses)));
    }

    app.get('/api/v1/whitelist', async () => {
        const addresses = await getWhitelist();
        return { addresses, ok: 1 };
    });

    app.post('/api/v1/whitelist', async (
        req: FastifyRequest<{ Body: { address: string; action: 'add' | 'remove' } }>,
        reply: FastifyReply,
    ) => {
        // N3 fix: Whitelist mutation requires authentication
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required to modify whitelist' });
        }
        const body = req.body as { address: string; action: string };
        if (!body?.address) {
            return reply.status(400).send({ ok: 0, errmsg: 'address is required' });
        }
        let addresses = await getWhitelist();
        if (body.action === 'add') {
            if (!addresses.includes(body.address)) {
                addresses.push(body.address);
            }
        } else if (body.action === 'remove') {
            addresses = addresses.filter(a => a !== body.address);
        }
        await saveWhitelist(addresses);
        return { ok: 1, addresses };
    });

    // ════════════════════════════════════════════════════════
    // SIWE Authentication Endpoints (cookie-based via iron-session)
    // ════════════════════════════════════════════════════════

    app.post('/api/v1/auth/nonce', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (
        req: FastifyRequest<{ Body: { address: string } }>,
        reply: FastifyReply,
    ) => {
        const { address } = req.body || {} as { address: string };
        if (!address || !address.startsWith('0x')) {
            return reply.status(400).send({ ok: 0, errmsg: 'Valid Ethereum address required' });
        }
        const nonce = siweGenerateNonce();

        // Store nonce in session cookie for verification in the next step
        const session = await getIronSession<SessionData>(req.raw, reply.raw, sessionOptions);
        session.nonce = nonce;
        await session.save();

        return { nonce, ok: 1 };
    });

    app.post('/api/v1/auth/verify', {
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    }, async (
        req: FastifyRequest<{ Body: { message: string; signature: string } }>,
        reply: FastifyReply,
    ) => {
        const { message, signature } = req.body || {} as { message: string; signature: string };
        if (!message || !signature) {
            return reply.status(400).send({ ok: 0, errmsg: 'message and signature are required' });
        }
        try {
            const session = await getIronSession<SessionData>(req.raw, reply.raw, sessionOptions);
            const siweMessage = new SiweMessage(message);

            // Verify signature + nonce + domain + expiry via the official SIWE package
            const { data: fields } = await siweMessage.verify({
                signature,
                nonce: session.nonce,
            });

            // Set authenticated session
            session.address = fields.address.toLowerCase();
            session.chainId = fields.chainId;
            session.nonce = undefined; // Consume nonce (one-time use)

            // Generate CSRF token for double-submit cookie pattern
            const csrfToken = randomBytes(32).toString('hex');
            session.csrfToken = csrfToken;
            await session.save();

            // Set non-httpOnly CSRF cookie so dashboard JS can read it
            reply.setCookie('plugport_csrf', csrfToken, {
                httpOnly: false,
                secure: process.env.NODE_ENV === 'production',
                sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
                path: '/',
                maxAge: 60 * 60 * 24, // 24 hours
            });

            return { address: session.address, ok: 1 };
        } catch (err) {
            return reply.status(401).send({ ok: 0, errmsg: err instanceof Error ? err.message : 'Verification failed' });
        }
    });

    app.get('/api/v1/auth/me', {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    }, async (req: FastifyRequest, reply: FastifyReply) => {
        // Read session from cookie (also populated by middleware for non-auth routes)
        const session = await getIronSession<SessionData>(req.raw, reply.raw, sessionOptions);
        if (!session.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Not authenticated' });
        }
        return { address: session.address, chainId: session.chainId, ok: 1 };
    });

    app.post('/api/v1/auth/logout', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (req: FastifyRequest, reply: FastifyReply) => {
        const session = await getIronSession<SessionData>(req.raw, reply.raw, sessionOptions);
        session.destroy();
        // Clear CSRF cookie alongside session
        reply.clearCookie('plugport_csrf', {
            path: '/',
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        });
        return { ok: 1 };
    });

    // ════════════════════════════════════════════════════════
    // API Key Management Endpoints
    // ════════════════════════════════════════════════════════

    app.post('/api/v1/keys/generate', async (
        req: FastifyRequest<{ Body: { label: string; permissions?: ApiKeyPermission[]; rateLimit?: number } }>,
        reply: FastifyReply,
    ) => {
        if (!req.user?.address || req.user.authMethod !== 'wallet') {
            return reply.status(401).send({ ok: 0, errmsg: 'Wallet authentication required to generate API keys' });
        }
        const { label, permissions, rateLimit: limit } = req.body || {} as { label: string; permissions?: ApiKeyPermission[]; rateLimit?: number };
        if (!label) {
            return reply.status(400).send({ ok: 0, errmsg: 'label is required' });
        }
        try {
            const result = await apiKeyManager.generateKey(
                req.user.address,
                label,
                permissions || ['all'],
                limit || 100,
            );
            return { apiKey: result.apiKey, hash: result.hash, metadata: result.metadata, ok: 1 };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    app.get('/api/v1/keys', async (req: FastifyRequest, reply: FastifyReply) => {
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required' });
        }
        const keys = await apiKeyManager.listKeys(req.user.address);
        return { keys, ok: 1 };
    });

    app.delete('/api/v1/keys/:hash', async (
        req: FastifyRequest<{ Params: { hash: string } }>,
        reply: FastifyReply,
    ) => {
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required' });
        }
        const revoked = await apiKeyManager.revokeKey(req.params.hash, req.user.address);
        if (!revoked) {
            return reply.status(404).send({ ok: 0, errmsg: 'Key not found or not owned by you' });
        }
        return { ok: 1, revoked: true };
    });

    app.post('/api/v1/keys/:hash/rotate', async (
        req: FastifyRequest<{ Params: { hash: string } }>,
        reply: FastifyReply,
    ) => {
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required' });
        }
        const result = await apiKeyManager.rotateKey(req.params.hash, req.user.address);
        if (!result) {
            return reply.status(404).send({ ok: 0, errmsg: 'Key not found or not owned by you' });
        }
        return { apiKey: result.apiKey, hash: result.hash, metadata: result.metadata, ok: 1 };
    });

    app.put('/api/v1/keys/:hash/permissions', async (
        req: FastifyRequest<{ Params: { hash: string }; Body: { permissions: ApiKeyPermission[] } }>,
        reply: FastifyReply,
    ) => {
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required' });
        }
        const { permissions } = req.body || {} as { permissions: ApiKeyPermission[] };
        if (!permissions?.length) {
            return reply.status(400).send({ ok: 0, errmsg: 'permissions array is required' });
        }
        const updated = await apiKeyManager.updatePermissions(req.params.hash, req.user.address, permissions);
        if (!updated) {
            return reply.status(404).send({ ok: 0, errmsg: 'Key not found or not owned by you' });
        }
        return { ok: 1, updated: true };
    });

    // ════════════════════════════════════════════════════════
    // Per-Key Analytics Endpoints
    // ════════════════════════════════════════════════════════

    app.get('/api/v1/keys/:hash/analytics', async (
        req: FastifyRequest<{ Params: { hash: string }; Querystring: { days?: string } }>,
        reply: FastifyReply,
    ) => {
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required' });
        }
        // Verify key ownership
        const keyMeta = await apiKeyManager.getKeyMetadata(req.params.hash);
        if (!keyMeta || keyMeta.ownerAddress !== req.user.address) {
            return reply.status(404).send({ ok: 0, errmsg: 'Key not found or not owned by you' });
        }
        const days = parseInt((req.query as any)?.days || '7', 10);
        const analytics = await analyticsRecorder.getAnalytics(req.params.hash, days);
        return { analytics, ok: 1 };
    });

    app.get('/api/v1/analytics/overview', async (req: FastifyRequest, reply: FastifyReply) => {
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required' });
        }
        const keys = await apiKeyManager.listKeys(req.user.address);
        const hashes = keys.map(k => k.hash);
        const overview = await analyticsRecorder.getOverviewForOwner(hashes);
        return { overview, ok: 1 };
    });

    // ════════════════════════════════════════════════════════
    // Per-Collection Privacy Endpoints
    // ════════════════════════════════════════════════════════

    app.get('/api/v1/collections/:name/privacy', async (
        req: FastifyRequest<{ Params: { name: string } }>,
    ) => {
        const privacy = await privacyManager.getCollectionPrivacy(req.params.name);
        if (!privacy) return { privacy: null, ok: 1 };

        // N2 fix: Return reduced payload for non-owners
        const callerAddress = req.user?.address?.toLowerCase();
        if (callerAddress && callerAddress === privacy.ownerAddress) {
            // Owner sees everything
            return { privacy, ok: 1 };
        }
        // Non-owner or unauthenticated: only expose mode (no ACL, no contract address)
        return {
            privacy: {
                mode: privacy.mode,
                ownerAddress: privacy.ownerAddress,
            },
            ok: 1,
        };
    });

    app.post('/api/v1/collections/:name/privacy', async (
        req: FastifyRequest<{ Params: { name: string }; Body: { mode: 'public' | 'private'; contractAddress?: string } }>,
        reply: FastifyReply,
    ) => {
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required to change privacy' });
        }
        // S6 fix: Only the collection owner (or first-time setter) can change privacy mode
        const existingPrivacy = await privacyManager.getCollectionPrivacy(req.params.name);
        if (existingPrivacy && existingPrivacy.ownerAddress && existingPrivacy.ownerAddress !== req.user.address.toLowerCase()) {
            return reply.status(403).send({ ok: 0, errmsg: 'Only the collection owner can change privacy mode' });
        }
        const { mode, contractAddress } = req.body || {} as { mode: 'public' | 'private'; contractAddress?: string };
        if (!mode || !['public', 'private'].includes(mode)) {
            return reply.status(400).send({ ok: 0, errmsg: 'mode must be "public" or "private"' });
        }
        await privacyManager.setCollectionPrivacy(req.params.name, mode, req.user.address, contractAddress);
        return { ok: 1, collection: req.params.name, mode };
    });

    app.get('/api/v1/collections/:name/roles', async (
        req: FastifyRequest<{ Params: { name: string } }>,
        reply: FastifyReply,
    ) => {
        // N1 fix: Require authentication to view access roles
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required to view access roles' });
        }
        const privacy = await privacyManager.getCollectionPrivacy(req.params.name);
        if (!privacy) {
            return { accessRoles: {}, ok: 1 };
        }
        // N1 fix: Only the collection owner can view the full ACL
        if (privacy.ownerAddress !== req.user.address.toLowerCase()) {
            return reply.status(403).send({ ok: 0, errmsg: 'Only the collection owner can view access roles' });
        }
        return { accessRoles: privacy.accessRoles || {}, ok: 1 };
    });

    app.post('/api/v1/collections/:name/roles', async (
        req: FastifyRequest<{ Params: { name: string }; Body: { address: string; action: 'grant' | 'revoke'; role?: number } }>,
        reply: FastifyReply,
    ) => {
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required' });
        }
        const { address, action, role } = req.body || {} as any;
        if (!address?.startsWith('0x')) {
            return reply.status(400).send({ ok: 0, errmsg: 'Valid Ethereum address required' });
        }
        // N4 fix: Explicit ownership check and error handling
        const privacy = await privacyManager.getCollectionPrivacy(req.params.name);
        if (!privacy) {
            return reply.status(404).send({ ok: 0, errmsg: `Collection "${req.params.name}" has no privacy settings configured. Set privacy mode first.` });
        }
        if (privacy.ownerAddress !== req.user.address.toLowerCase()) {
            return reply.status(403).send({ ok: 0, errmsg: 'Only the collection owner can modify access roles' });
        }
        if (action === 'grant') {
            if (role !== 1 && role !== 2) return reply.status(400).send({ ok: 0, errmsg: 'role must be 1 (read) or 2 (write)' });
            await privacyManager.grantAccess(req.params.name, address, role, req.user.address);
        } else if (action === 'revoke') {
            await privacyManager.revokeAccess(req.params.name, address, req.user.address);
        } else {
            return reply.status(400).send({ ok: 0, errmsg: 'action must be "grant" or "revoke"' });
        }
        const updatedPrivacy = await privacyManager.getCollectionPrivacy(req.params.name);
        return { accessRoles: updatedPrivacy?.accessRoles || {}, ok: 1 };
    });

    // ════════════════════════════════════════════════════════
    // User-Scoped Endpoints
    // ════════════════════════════════════════════════════════

    app.get('/api/v1/user/:address/collections', async (
        req: FastifyRequest<{ Params: { address: string } }>,
        reply: FastifyReply,
    ) => {
        // S3 fix: Only the authenticated user can view their own data
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required' });
        }
        const address = req.params.address.toLowerCase();
        if (req.user.address.toLowerCase() !== address) {
            return reply.status(403).send({ ok: 0, errmsg: 'You can only view your own collections' });
        }
        const allCollections = await store.listCollections();
        const userCollections = [];
        for (const c of allCollections) {
            const privacy = await privacyManager.getCollectionPrivacy(c.name);
            if (privacy?.ownerAddress === address) {
                userCollections.push({
                    name: c.name,
                    documentCount: c.documentCount,
                    indexCount: c.indexes.length,
                    mode: privacy.mode,
                });
            }
        }
        return { collections: userCollections, ok: 1 };
    });

    app.get('/api/v1/user/:address/metrics', async (
        req: FastifyRequest<{ Params: { address: string } }>,
        reply: FastifyReply,
    ) => {
        // S3 fix: Only the authenticated user can view their own metrics
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required' });
        }
        const address = req.params.address.toLowerCase();
        if (req.user.address.toLowerCase() !== address) {
            return reply.status(403).send({ ok: 0, errmsg: 'You can only view your own metrics' });
        }
        const keys = await apiKeyManager.listKeys(address);
        const hashes = keys.map(k => k.hash);
        const overview = await analyticsRecorder.getOverviewForOwner(hashes);

        // Count user's collections and documents
        const allCollections = await store.listCollections();
        let userCollections = 0;
        let userDocuments = 0;
        for (const c of allCollections) {
            const privacy = await privacyManager.getCollectionPrivacy(c.name);
            if (privacy?.ownerAddress === address) {
                userCollections++;
                userDocuments += c.documentCount;
            }
        }

        return {
            address,
            collections: userCollections,
            documents: userDocuments,
            apiKeys: keys.length,
            totalRequests: overview.totalRequests,
            ok: 1,
        };
    });

    // ════════════════════════════════════════════════════════
    // Contract Registration (Deployment Wizard)
    // ════════════════════════════════════════════════════════

    app.post('/api/v1/deploy/register', async (
        req: FastifyRequest<{ Body: { contractAddress: string; contractType: string } }>,
        reply: FastifyReply,
    ) => {
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required' });
        }
        const { contractAddress, contractType } = req.body || {} as any;
        if (!contractAddress || !contractType) {
            return reply.status(400).send({ ok: 0, errmsg: 'contractAddress and contractType are required' });
        }
        // S4 fix: Always use the authenticated user's address — never accept ownerAddress from body
        const key = `meta:contract:${contractAddress.toLowerCase()}`;
        await kvStore.put(key, Buffer.from(JSON.stringify({
            ownerAddress: req.user.address.toLowerCase(),
            type: contractType,
            createdAt: Date.now(),
        })));
        return { ok: 1, registered: true };
    });

    app.get('/api/v1/deploy/contracts', async (req: FastifyRequest, reply: FastifyReply) => {
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required' });
        }
        // Scan for contracts owned by the user using prefix scan
        const contracts: Array<{ address: string; type: string; createdAt: number }> = [];
        const entries = await kvStore.scan({ prefix: 'meta:contract:', limit: 10000 });
        for (const entry of entries) {
            try {
                const meta = JSON.parse(entry.value.toString());
                if (meta.ownerAddress === req.user.address) {
                    contracts.push({
                        address: entry.key.replace('meta:contract:', ''),
                        type: meta.type,
                        createdAt: meta.createdAt,
                    });
                }
            } catch (err) {
                console.warn(`[Deploy] Malformed contract metadata for key "${entry.key}":`, err instanceof Error ? err.message : 'parse error');
            }
        }
        return { contracts, ok: 1 };
    });

    // ════════════════════════════════════════════════════════
    // Gas Station Balance Check
    // ════════════════════════════════════════════════════════

    app.get('/api/v1/deploy/gas-station/:address/balance', async (
        req: FastifyRequest<{ Params: { address: string } }>,
        reply: FastifyReply,
    ) => {
        // S5 fix: Require authentication to prevent using server as free RPC proxy
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required' });
        }
        const address = req.params.address;
        // S5 fix: Validate Ethereum address format
        if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
            return reply.status(400).send({ ok: 0, errmsg: 'Invalid Ethereum address format' });
        }
        const rpcUrl = process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz';

        try {
            const response = await fetch(rpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'eth_getBalance',
                    params: [address, 'latest'],
                }),
            });
            const json = await response.json() as { result?: string; error?: { message: string } };
            if (json.error) {
                return { ok: 0, errmsg: json.error.message };
            }

            const balanceWei = BigInt(json.result || '0x0');
            // N6 fix: Pure BigInt string arithmetic — no Number() precision loss at any scale
            const wholePart = balanceWei / (10n ** 18n);
            const fracPart = (balanceWei % (10n ** 18n)).toString().padStart(18, '0').slice(0, 6);
            const balanceStr = `${wholePart}.${fracPart}`;

            // Estimate operations: ~50k gas per PlugPort op, ~50 gwei avg gas price
            const avgCostPerOp = BigInt(50_000) * BigInt(50_000_000); // in wei
            const estimatedOps = avgCostPerOp > 0n ? Number(balanceWei / avgCostPerOp) : 0;

            const LOW_THRESHOLD_WEI = 10n ** 17n; // 0.1 MON in wei

            return {
                address,
                balance: balanceStr,
                balanceWei: balanceWei.toString(),
                estimatedOps,
                isLow: balanceWei < LOW_THRESHOLD_WEI,
                ok: 1,
            };
        } catch (err) {
            return { ok: 0, errmsg: err instanceof Error ? err.message : 'RPC request failed' };
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
    if (url.includes('/keys/')) return 'keys';
    if (url.includes('/auth/')) return 'auth';
    if (url.includes('/privacy')) return 'privacy';
    if (url.includes('/whitelist')) return 'whitelist';
    if (url.includes('collections')) return 'listCollections';
    return `${method.toLowerCase()}:unknown`;
}

/**
 * Extract collection name from URL path.
 * e.g., /api/v1/collections/users/find → "users"
 */
function extractCollection(url: string): string | null {
    const match = url.match(/\/api\/v1\/collections\/([^/]+)/);
    return match ? match[1] : null;
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
