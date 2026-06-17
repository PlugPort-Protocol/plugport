// PlugPort HTTP API Server
// Fastify-based REST API providing CRUD endpoints, auth, API key management,
// per-collection privacy, analytics, and protocol management.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { timingSafeEqual } from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { DocumentStore, DocumentStoreError } from './storage/document-store.js';
import { MetricsCollector } from './metrics.js';
import { SIWEHandler } from './auth/siwe-handler.js';
import { ApiKeyManager, type ApiKeyPermission } from './auth/api-key-manager.js';
import { AnalyticsRecorder } from './auth/analytics-recorder.js';
import { PrivacyManager } from './storage/privacy-manager.js';
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
    storageMode?: string;
    whitelistAddresses?: string[];
    jwtSecret?: string;
}

export async function createHttpServer(options: HttpServerOptions): Promise<FastifyInstance> {
    const { store, metrics, kvStore, apiKey } = options;

    // Initialize auth subsystems
    const siweHandler = new SIWEHandler({ jwtSecret: options.jwtSecret });
    const apiKeyManager = new ApiKeyManager(kvStore);
    const analyticsRecorder = new AnalyticsRecorder(kvStore);
    const privacyManager = new PrivacyManager(kvStore);

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
    await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });
    await app.register(rateLimit, {
        max: 100, // Limit each IP to 100 requests
        timeWindow: '10 seconds' // per 10 seconds (600 RPM)
    });

    // ---- Triple-Auth Middleware ----
    // Priority: (1) JWT Bearer → wallet auth, (2) pp_live_/pp_test_ → wallet-linked API key,
    //           (3) legacy x-api-key → static API key from .env
    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        const path = request.url;

        // Public endpoints — no auth required
        if (path === '/health' || path === '/metrics' || path.startsWith('/api/v1/metrics')
            || path.startsWith('/api/v1/auth/')) {
            request.user = { authMethod: 'none' };
            return;
        }

        const authHeader = request.headers.authorization;
        const xApiKey = request.headers['x-api-key'] as string;

        // Method 1: JWT Bearer token (wallet auth via SIWE)
        if (authHeader?.startsWith('Bearer ')) {
            const token = authHeader.slice(7);
            // Check if it's a JWT (not a legacy API key)
            if (token.includes('.')) {
                try {
                    const session = await siweHandler.validateToken(token);
                    request.user = { address: session.address, authMethod: 'wallet' };
                    return;
                } catch {
                    // Fall through to other methods
                }
            }
        }

        // Method 2: Wallet-linked API key (pp_live_... or pp_test_...)
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
            }).catch(() => {}); // Fire-and-forget, don't block response
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
            storageMode: options.storageMode || 'public',
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

    // ---- Protocol Management Endpoints ----

    app.get('/api/v1/protocols', async () => {
        if (!options.protocolManager) {
            return { protocols: [], ok: 1 };
        }
        return { protocols: options.protocolManager.getStatus(), ok: 1 };
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

    // ---- Whitelist Management (Legacy — global) ----

    app.get('/api/v1/whitelist', async () => {
        return { addresses: options.whitelistAddresses || [], ok: 1 };
    });

    app.post('/api/v1/whitelist', async (
        req: FastifyRequest<{ Body: { address: string; action: 'add' | 'remove' } }>,
        reply: FastifyReply,
    ) => {
        const body = req.body as { address: string; action: string };
        if (!body?.address) {
            return reply.status(400).send({ ok: 0, errmsg: 'address is required' });
        }
        if (!options.whitelistAddresses) {
            options.whitelistAddresses = [];
        }
        if (body.action === 'add') {
            if (!options.whitelistAddresses.includes(body.address)) {
                options.whitelistAddresses.push(body.address);
            }
        } else if (body.action === 'remove') {
            options.whitelistAddresses = options.whitelistAddresses.filter(a => a !== body.address);
        }
        return { ok: 1, addresses: options.whitelistAddresses };
    });

    // ════════════════════════════════════════════════════════
    // SIWE Authentication Endpoints
    // ════════════════════════════════════════════════════════

    app.post('/api/v1/auth/nonce', async (
        req: FastifyRequest<{ Body: { address: string } }>,
        reply: FastifyReply,
    ) => {
        const { address } = req.body || {} as { address: string };
        if (!address || !address.startsWith('0x')) {
            return reply.status(400).send({ ok: 0, errmsg: 'Valid Ethereum address required' });
        }
        const nonce = siweHandler.generateNonce(address);
        return { nonce, ok: 1 };
    });

    app.post('/api/v1/auth/verify', async (
        req: FastifyRequest<{ Body: { message: string; signature: string; address: string } }>,
        reply: FastifyReply,
    ) => {
        const { message, signature, address } = req.body || {} as { message: string; signature: string; address: string };
        if (!message || !signature || !address) {
            return reply.status(400).send({ ok: 0, errmsg: 'message, signature, and address are required' });
        }
        try {
            const result = await siweHandler.verify(message, signature, address);
            return { token: result.token, address: result.address, ok: 1 };
        } catch (err) {
            return reply.status(401).send({ ok: 0, errmsg: err instanceof Error ? err.message : 'Verification failed' });
        }
    });

    app.get('/api/v1/auth/me', async (req: FastifyRequest, reply: FastifyReply) => {
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Not authenticated' });
        }
        return { address: req.user.address, authMethod: req.user.authMethod, ok: 1 };
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
        return { privacy, ok: 1 };
    });

    app.post('/api/v1/collections/:name/privacy', async (
        req: FastifyRequest<{ Params: { name: string }; Body: { mode: 'public' | 'private'; contractAddress?: string } }>,
        reply: FastifyReply,
    ) => {
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required to change privacy' });
        }
        const { mode, contractAddress } = req.body || {} as { mode: 'public' | 'private'; contractAddress?: string };
        if (!mode || !['public', 'private'].includes(mode)) {
            return reply.status(400).send({ ok: 0, errmsg: 'mode must be "public" or "private"' });
        }
        await privacyManager.setCollectionPrivacy(req.params.name, mode, req.user.address, contractAddress);
        return { ok: 1, collection: req.params.name, mode };
    });

    app.get('/api/v1/collections/:name/whitelist', async (
        req: FastifyRequest<{ Params: { name: string } }>,
    ) => {
        const privacy = await privacyManager.getCollectionPrivacy(req.params.name);
        return { addresses: privacy?.whitelistedAddresses || [], ok: 1 };
    });

    app.post('/api/v1/collections/:name/whitelist', async (
        req: FastifyRequest<{ Params: { name: string }; Body: { address: string; action: 'add' | 'remove' } }>,
        reply: FastifyReply,
    ) => {
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required' });
        }
        const { address, action } = req.body || {} as { address: string; action: string };
        if (!address?.startsWith('0x')) {
            return reply.status(400).send({ ok: 0, errmsg: 'Valid Ethereum address required' });
        }
        if (action === 'add') {
            await privacyManager.addWhitelist(req.params.name, address, req.user.address);
        } else if (action === 'remove') {
            await privacyManager.removeWhitelist(req.params.name, address, req.user.address);
        } else {
            return reply.status(400).send({ ok: 0, errmsg: 'action must be "add" or "remove"' });
        }
        const privacy = await privacyManager.getCollectionPrivacy(req.params.name);
        return { addresses: privacy?.whitelistedAddresses || [], ok: 1 };
    });

    // ════════════════════════════════════════════════════════
    // User-Scoped Endpoints
    // ════════════════════════════════════════════════════════

    app.get('/api/v1/user/:address/collections', async (
        req: FastifyRequest<{ Params: { address: string } }>,
    ) => {
        const address = req.params.address.toLowerCase();
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
    ) => {
        const address = req.params.address.toLowerCase();
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
        req: FastifyRequest<{ Body: { contractAddress: string; contractType: string; ownerAddress: string } }>,
        reply: FastifyReply,
    ) => {
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required' });
        }
        const { contractAddress, contractType, ownerAddress } = req.body || {} as any;
        if (!contractAddress || !contractType) {
            return reply.status(400).send({ ok: 0, errmsg: 'contractAddress and contractType are required' });
        }
        const key = `meta:contract:${contractAddress.toLowerCase()}`;
        await kvStore.put(key, Buffer.from(JSON.stringify({
            ownerAddress: (ownerAddress || req.user.address).toLowerCase(),
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
        const entries = await kvStore.scan({ prefix: 'meta:contract:' });
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
            } catch { /* skip malformed entries */ }
        }
        return { contracts, ok: 1 };
    });

    // ════════════════════════════════════════════════════════
    // Gas Station Balance Check
    // ════════════════════════════════════════════════════════

    app.get('/api/v1/deploy/gas-station/:address/balance', async (
        req: FastifyRequest<{ Params: { address: string } }>,
    ) => {
        const address = req.params.address;
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
            const balanceEth = Number(balanceWei) / 1e18;

            // Estimate operations: ~50k gas per PlugPort op, ~50 gwei avg gas price
            const avgCostPerOp = 50_000 * 50_000_000; // in wei
            const estimatedOps = avgCostPerOp > 0 ? Math.floor(Number(balanceWei) / avgCostPerOp) : 0;

            const LOW_THRESHOLD = 0.1; // MON

            return {
                address,
                balance: balanceEth.toFixed(6),
                balanceWei: balanceWei.toString(),
                estimatedOps,
                isLow: balanceEth < LOW_THRESHOLD,
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
