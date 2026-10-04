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
import { getAuthContract, AuthReadError } from './auth/auth-contract.js';
import { createRpcProvider } from './storage/rpc-provider.js';
import { PrivacyManager } from './storage/privacy-manager.js';
import type { PrivateStoreRegistry } from './storage/private-store-registry.js';
import { CollectionBusyError, StoreDetachedError, type RoutingAdapter } from './storage/routing-adapter.js';
import type { StoreMigrations } from './storage/store-migrations.js';
import { CollectionClaims } from './storage/collection-claims.js';
import { CollectionAccess, resolveQueryCollections, type Caller } from './storage/collection-access.js';
import { Namespaces, namespaceOwner } from './storage/namespaces.js';

/** Largest collection (documents plus index entries) a privacy switch moves in one request. */
const MAX_SYNC_MIGRATION_KEYS = 2000;
import { SQLTranslator, executeAggregation } from './protocols/sql-translator.js';
import type { TranslatedQuery, SQLDialect } from './protocols/sql-translator.js';
import { JoinEngine } from './protocols/join-engine.js';
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
        getActiveProtocols(): Array<{ name: string; enabled: boolean; port: number; connections: number; connectionString: string }>;
        enableProtocol(name: string): Promise<void>;
        disableProtocol(name: string): Promise<void>;
    };
    whitelistAddresses?: string[];
    /** Share with every other component that reads or claims collection privacy, so its cache stays coherent. */
    privacyManager?: PrivacyManager;
    /** Per-customer private stores; omitted when the factory isn't configured. */
    privateStores?: PrivateStoreRegistry;
    /** Moves customers' private data into their own stores once linked. */
    storeMigrations?: StoreMigrations;
    /** Per-wallet namespaces, loaded (see storage/namespaces.ts); shared with the wire servers. */
    namespaces?: Namespaces;
    /** Allowed origin for CORS credentials (defaults to DASHBOARD_URL env var) */
    dashboardUrl?: string;
}

export async function createHttpServer(options: HttpServerOptions): Promise<FastifyInstance> {
    const { store, metrics, kvStore, apiKey } = options;

    // Initialize auth subsystems
    const sessionOptions = getSessionOptions();
    const apiKeyManager = new ApiKeyManager(kvStore);
    const analyticsRecorder = new AnalyticsRecorder(kvStore);
    const privacyManager = options.privacyManager ?? new PrivacyManager(kvStore);
    const privateStores = options.privateStores;
    const storeMigrations = options.storeMigrations;
    // New collections: private by default, in the owner's own store when active.
    const collectionClaims = new CollectionClaims(privacyManager, privateStores);
    // One access rule for HTTP and the wire protocols (see collection-access.ts).
    const collectionAccess = new CollectionAccess(privacyManager, store, collectionClaims);
    let namespaces = options.namespaces;
    if (!namespaces) {
        namespaces = new Namespaces(store, privacyManager);
        await namespaces.load();
    }
    const joinEngine = new JoinEngine();
    if ('setPrivacyManager' in kvStore && typeof kvStore.setPrivacyManager === 'function') {
        kvStore.setPrivacyManager(privacyManager);
    }

    // Every write here triggers a real on-chain transaction against the
    // shared gas-station wallet — the global default (100 req/10s per IP)
    // left these completely unthrottled, and this session has repeatedly
    // observed firsthand that even modest concurrent write bursts (well
    // under 100) cause real RPC nonce contention ("existing transaction had
    // higher priority"). This is a much stricter per-route cap for exactly
    // the endpoints that cost real gas, so a single IP can't single-handedly
    // drain the gas station or starve everyone else's writes out.
    const WRITE_RATE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: '10 seconds' } } };

    const app = Fastify({
        // A parsed JSON body can take 21x its size in heap (measured: 6 MB of
        // `[{},{},…]` → 128 MB), so 50 MB bodies could exhaust the heap alone.
        // Documents are capped at 1 MB; 4 MB still allows sizeable batches.
        bodyLimit: 4 * 1024 * 1024,
        // Tests: warnings only, and no pino-pretty — its worker thread per server
        // made parallel test runs fail to start threads (EINVAL) on Windows.
        logger: process.env.NODE_ENV === 'test' ? { level: 'warn' }
            : process.env.NODE_ENV === 'production'
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

    // Read-only listing endpoints that stay viewable without any
    // credentials — a disconnected-wallet visitor should see real overview
    // data (dashboard Overview tab, Protocols tab), not the legacy API
    // key's blanket 401 that every other route correctly enforces. A
    // connected wallet's session still takes priority (checked first,
    // below) so an authenticated caller keeps seeing their own private
    // collections too — this only relaxes the *fallback* 401 when no
    // credentials are present at all. The /api/v1/collections handler
    // itself still filters out private collections the caller can't read.
    const SOFT_PUBLIC_PATHS = new Set(['/api/v1/collections', '/api/v1/protocols']);

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
            if (SOFT_PUBLIC_PATHS.has(path)) {
                request.user = { authMethod: 'none' };
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
            if (SOFT_PUBLIC_PATHS.has(path)) {
                request.user = { authMethod: 'none' };
                return;
            }
            return reply.status(401).send({ ok: 0, code: 13, errmsg: 'Unauthorized' });
        }

        // No auth configured — open access (dev mode)
        request.user = { authMethod: 'none' };
    });

    // Analytics are batched in memory (see AnalyticsRecorder) — write out
    // whatever is pending when the server shuts down.
    app.addHook('onClose', async () => {
        await analyticsRecorder.close();
    });

    // Request timing + API key analytics
    app.addHook('onResponse', async (request, reply) => {
        const duration = reply.elapsedTime;
        const command = extractCommand(request.url, request.method);
        metrics.recordRequest(command, 'http', duration, reply.statusCode < 400);

        // Record analytics for both auth methods that identify a specific
        // owner: wallet-linked API keys (keyed by key hash, as before) and
        // SIWE wallet sessions (keyed by address) — normal dashboard usage
        // authenticates via the latter, and previously went unrecorded
        // entirely, undercounting "My Requests" on the Metrics tab for
        // anyone not using a raw API key. AnalyticsRecorder doesn't care
        // what the identifier string represents, so a `wallet:` prefix on
        // the address keeps the two namespaces unambiguous in storage.
        const analyticsId = request.user?.authMethod === 'apiKey' && request.user.keyHash
            ? request.user.keyHash
            : request.user?.authMethod === 'wallet' && request.user.address
                ? `wallet:${request.user.address.toLowerCase()}`
                : null;

        if (analyticsId) {
            const collection = extractCollection(request.url);
            analyticsRecorder.record(analyticsId, {
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
            result.protocols = options.protocolManager.getActiveProtocols();
        }
        return result;
    });

    app.get('/metrics', async (_req, reply) => {
        // Without this, plugport_storage_keys_total/plugport_storage_size_bytes
        // would always read 0 in Prometheus/Grafana — only /api/v1/metrics
        // (the dashboard's own JSON endpoint, not what Prometheus scrapes)
        // used to refresh these gauges.
        metrics.updateStorageMetrics(kvStore.getKeyCount(), kvStore.getEstimatedSizeBytes());
        const metricsText = await metrics.getPrometheusMetrics();
        reply.type(metrics.getContentType()).send(metricsText);
    });

    app.get('/api/v1/metrics', async () => {
        metrics.updateStorageMetrics(kvStore.getKeyCount(), kvStore.getEstimatedSizeBytes());
        return metrics.getSnapshot();
    });

    // ---- Access Control Helper ----

    /**
     * Reads: public collections are readable by anyone; private ones by their
     * owner and granted wallets. Writes: only the owner and wallets granted
     * write access. A wallet writing to a collection that doesn't exist yet
     * claims it *before* the write, so it appears under that wallet's "My
     * Collections" and a concurrent writer can't slip data into a collection
     * it won't own. An existing collection with no owner (created before
     * ownership existed) is read-only for wallets.
     *
     * The operator — the server's master API_KEY, or dev mode with no key
     * configured — carries no wallet and may write to any non-private collection.
     */
    function callerOf(req: FastifyRequest): Caller {
        const operator = req.user?.authMethod === 'legacyKey' || (req.user?.authMethod === 'none' && !apiKey);
        return { wallet: req.user?.address, operator };
    }

    async function checkAccess(req: FastifyRequest, reply: FastifyReply, collection: string, type: 'read' | 'write'): Promise<boolean> {
        const result = await collectionAccess.check(collection, callerOf(req), type);
        if (result.ok) return true;
        reply.status(403).send({ ok: 0, errmsg: result.errmsg });
        return false;
    }

    // ---- Collection Management ----

    // Per-wallet namespaces: every /collections/:name route works on the
    // physical collection the caller's name refers to (see storage/namespaces.ts).
    const READ_ROUTES = /\/(find|findOne|count|distinct|aggregate)$/;
    app.addHook('preHandler', async (req) => {
        const route = req.routeOptions.url ?? '';
        const params = req.params as { name?: string } | undefined;
        if (!params?.name || !route.startsWith('/api/v1/collections/:name')) return;
        const intent = req.method === 'GET' || READ_ROUTES.test(route) ? 'read' : 'write';
        params.name = await namespaces.resolve(params.name, callerOf(req), intent);
    });

    app.get('/api/v1/collections', async (req: FastifyRequest) => {
        const all = await store.listCollections();
        const address = req.user?.address || '';
        const names = new Map(namespaces.view(all.map((c) => c.name), callerOf(req)).map((e) => [e.physical, e.name]));
        const collections = all.filter((c) => names.has(c.name));
        const mappedCollections = await Promise.all(collections.map(async (c) => {
            const privacy = await privacyManager.getCollectionPrivacy(c.name);
            const mode = privacy?.mode || 'public';
            // Only list collections the caller can actually read — a
            // private collection's name/owner/document count shouldn't be
            // visible to an anonymous visitor or an unrelated caller just
            // because listing itself doesn't require auth.
            const readable = mode !== 'private' || await privacyManager.hasReadAccess(c.name, address);
            if (!readable) return null;
            // Still listed when its store was cut off (metadata isn't in the store), flagged.
            const storeDetached = privacy?.storeAddress && privateStores
                ? !(await privateStores.checkWriter(privacy.storeAddress).catch(() => ({ ok: true }))).ok
                : false;
            return {
                name: names.get(c.name)!,
                documentCount: c.documentCount,
                indexCount: c.indexes.length,
                createdAt: c.options.createdAt,
                ownerAddress: privacy?.ownerAddress,
                mode,
                ...(storeDetached ? { storeDetached: true } : {}),
            };
        }));
        return { collections: mappedCollections.filter((c): c is NonNullable<typeof c> => c !== null), ok: 1 };
    });

    app.post('/api/v1/collections/:name/drop', WRITE_RATE_LIMIT, async (req: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
        const dropped = await store.dropCollection(req.params.name);
        return { acknowledged: true, dropped, ok: 1 };
    });

    // ---- Insert ----

    app.post('/api/v1/collections/:name/insertOne', WRITE_RATE_LIMIT, async (
        req: FastifyRequest<{ Params: { name: string }; Body: { document: Record<string, unknown> } }>,
        reply: FastifyReply,
    ) => {
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
        try {
            const result = await store.insert(req.params.name, [req.body.document]);
            return { ...result, ok: 1 };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    app.post('/api/v1/collections/:name/insertMany', WRITE_RATE_LIMIT, async (
        req: FastifyRequest<{ Params: { name: string }; Body: { documents: Record<string, unknown>[] } }>,
        reply: FastifyReply,
    ) => {
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
        try {
            const result = await store.insert(req.params.name, req.body.documents);
            return { ...result, ok: 1 };
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
            // awaited, so a rejection reaches the catch below (returned un-awaited, every error here became a 500)
            return await store.find(req.params.name, filter, { projection, sort, limit, skip });
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

    app.post('/api/v1/collections/:name/updateOne', WRITE_RATE_LIMIT, async (
        req: FastifyRequest<{
            Params: { name: string };
            Body: { filter: Filter; update: { $set?: Record<string, unknown>; $inc?: Record<string, number>; $unset?: Record<string, unknown> }; upsert?: boolean };
        }>,
        reply: FastifyReply,
    ) => {
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
        try {
            const { filter, update, upsert } = req.body;
            const result = await store.updateOne(req.params.name, filter, update, { upsert });
            return { ...result, ok: 1 };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    app.post('/api/v1/collections/:name/updateMany', WRITE_RATE_LIMIT, async (
        req: FastifyRequest<{
            Params: { name: string };
            Body: { filter: Filter; update: { $set?: Record<string, unknown>; $inc?: Record<string, number>; $unset?: Record<string, unknown> }; upsert?: boolean };
        }>,
        reply: FastifyReply,
    ) => {
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
        try {
            const { filter, update, upsert } = req.body;
            const result = await store.updateMany(req.params.name, filter, update, { upsert });
            return { ...result, ok: 1 };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    // ---- Delete ----

    app.post('/api/v1/collections/:name/deleteOne', WRITE_RATE_LIMIT, async (
        req: FastifyRequest<{
            Params: { name: string };
            Body: { filter: Filter };
        }>,
        reply: FastifyReply,
    ) => {
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
        try {
            const { filter } = req.body;
            const result = await store.deleteOne(req.params.name, filter);
            return { ...result, ok: 1 };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    app.post('/api/v1/collections/:name/deleteMany', WRITE_RATE_LIMIT, async (
        req: FastifyRequest<{
            Params: { name: string };
            Body: { filter: Filter };
        }>,
        reply: FastifyReply,
    ) => {
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
        try {
            const result = await store.deleteMany(req.params.name, req.body.filter);
            return { ...result, ok: 1 };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    // ---- Index Management ----

    app.post('/api/v1/collections/:name/createIndex', WRITE_RATE_LIMIT, async (
        req: FastifyRequest<{
            Params: { name: string };
            Body: { field: string; unique?: boolean };
        }>,
        reply: FastifyReply,
    ) => {
        if (!(await checkAccess(req, reply, req.params.name, 'write'))) return;
        if (!req.body.field || typeof req.body.field !== 'string') {
            return reply.status(400).send({ ok: 0, errmsg: 'field (string) required' });
        }
        try {
            const result = await store.createIndex(req.params.name, req.body.field, req.body.unique);
            return { ...result, ok: 1 };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    app.post('/api/v1/collections/:name/dropIndex', WRITE_RATE_LIMIT, async (
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

    // ---- Aggregation Pipeline ----

    app.post('/api/v1/collections/:name/aggregate', async (
        req: FastifyRequest<{
            Params: { name: string };
            Body: { pipeline?: Record<string, unknown>[] };
        }>,
        reply: FastifyReply,
    ) => {
        if (!(await checkAccess(req, reply, req.params.name, 'read'))) return;
        try {
            const { pipeline = [] } = req.body || {} as { pipeline?: Record<string, unknown>[] };
            const collName = req.params.name;

            // B4: Cap pipeline stage count to prevent DoS (same as wire protocol limit)
            if (pipeline.length > 50) {
                return reply.status(400).send({
                    ok: 0,
                    errmsg: `Pipeline exceeds maximum of 50 stages (got ${pipeline.length})`,
                    code: 15942,
                });
            }

            // Fetch initial documents
            const initialResult = await store.find(collName, {});
            let docs: Record<string, unknown>[] = initialResult.cursor.firstBatch as Record<string, unknown>[];

            for (const stage of pipeline) {
                const stageKey = Object.keys(stage)[0];

                switch (stageKey) {
                    case '$match': {
                        const filter = stage.$match as Record<string, unknown>;
                        const matchResult = await store.find(collName, filter);
                        // Re-filter from current docs instead of re-querying for chained pipelines
                        const matchIds = new Set(matchResult.cursor.firstBatch.map((d: any) => d._id));
                        docs = docs.filter((d: any) => matchIds.has(d._id));
                        break;
                    }

                    case '$lookup': {
                        const lookup = stage.$lookup as {
                            from: string; localField: string; foreignField: string; as: string;
                        };
                        // The joined collection is read too: it needs read access of its own.
                        const from = await namespaces.resolve(lookup.from, callerOf(req), 'read');
                        if (!(await checkAccess(req, reply, from, 'read'))) return;
                        const localValues = docs.map(doc => (doc as any)[lookup.localField]).filter(v => v != null);
                        let foreignDocs: Record<string, unknown>[] = [];
                        if (localValues.length > 0) {
                            const foreignResult = await store.find(from, {
                                [lookup.foreignField]: { $in: localValues },
                            });
                            foreignDocs = foreignResult.cursor.firstBatch as Record<string, unknown>[];
                        }
                        const lookupIndex = new Map<string, Record<string, unknown>[]>();
                        for (const fdoc of foreignDocs) {
                            const key = String((fdoc as any)[lookup.foreignField] ?? '');
                            if (!lookupIndex.has(key)) lookupIndex.set(key, []);
                            lookupIndex.get(key)!.push(fdoc);
                        }
                        docs = docs.map(doc => {
                            const localVal = String((doc as any)[lookup.localField] ?? '');
                            return { ...doc, [lookup.as]: lookupIndex.get(localVal) || [] };
                        });
                        break;
                    }

                    case '$project': {
                        const projection = stage.$project as Record<string, unknown>;
                        const include = Object.entries(projection).filter(([, v]) => v === 1 || v === true);
                        const exclude = Object.entries(projection).filter(([, v]) => v === 0 || v === false);
                        if (include.length > 0) {
                            const fields = new Set(include.map(([k]) => k));
                            fields.add('_id');
                            if (projection._id === 0 || projection._id === false) fields.delete('_id');
                            docs = docs.map(doc => {
                                const r: Record<string, unknown> = {};
                                for (const f of fields) { if (f in doc) r[f] = doc[f]; }
                                return r;
                            });
                        } else if (exclude.length > 0) {
                            const exFields = new Set(exclude.map(([k]) => k));
                            docs = docs.map(doc => {
                                const r: Record<string, unknown> = {};
                                for (const [k, v] of Object.entries(doc)) { if (!exFields.has(k)) r[k] = v; }
                                return r;
                            });
                        }
                        break;
                    }

                    case '$sort': {
                        const sortSpec = stage.$sort as Record<string, number>;
                        docs.sort((a, b) => {
                            for (const [field, dir] of Object.entries(sortSpec)) {
                                const av = (a as any)[field], bv = (b as any)[field];
                                if (av < bv) return -1 * dir;
                                if (av > bv) return 1 * dir;
                            }
                            return 0;
                        });
                        break;
                    }

                    case '$limit': docs = docs.slice(0, stage.$limit as number); break;
                    case '$skip': docs = docs.slice(stage.$skip as number); break;

                    case '$unwind': {
                        const path = (typeof stage.$unwind === 'string' ? stage.$unwind : (stage.$unwind as { path: string }).path).replace(/^\$/, '');
                        const unwound: Record<string, unknown>[] = [];
                        for (const doc of docs) {
                            const arr = (doc as any)[path];
                            if (Array.isArray(arr)) {
                                for (const item of arr) unwound.push({ ...doc, [path]: item });
                            } else if (arr != null) {
                                unwound.push(doc);
                            }
                        }
                        docs = unwound;
                        break;
                    }

                    case '$count': {
                        docs = [{ [stage.$count as string]: docs.length }];
                        break;
                    }
                }
            }

            return {
                cursor: { firstBatch: docs, id: 0, ns: `plugport.${collName}` },
                ok: 1,
            };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    // ---- On-Chain Auth Relay Endpoints ----
    // These endpoints relay EIP-712 signed meta-transactions to the PlugPortAuth
    // contract via the gas station wallet. The dashboard calls these after the user
    // signs a typed message in their wallet.

    app.post('/api/v1/auth/register-key', async (
        req: FastifyRequest<{
            Body: {
                keyOwner: string;
                commitment: string;
                salt: string;
                storedKey: string;
                serverKey: string;
                nonce: number;
                signature: string;
            };
        }>,
        reply: FastifyReply,
    ) => {
        try {
            const { keyOwner, commitment, salt, storedKey, serverKey, nonce, signature } = req.body;
            if (!keyOwner || !commitment || !salt || !storedKey || !serverKey || !signature) {
                return reply.status(400).send({ ok: 0, errmsg: 'Missing required fields' });
            }

            const authContract = getAuthContract();

            if (authContract.isConfigured) {
                // Live on-chain registration via gas station meta-tx
                const result = await authContract.registerKeyMeta(
                    keyOwner, commitment, salt, storedKey, serverKey, nonce, signature,
                );
                return {
                    ok: 1,
                    message: 'Key registered on-chain',
                    keyOwner,
                    keyIndex: result.keyIndex,
                    txHash: result.txHash,
                };
            }

            // Fallback: log-only mode when contract is not deployed
            console.log(`[Auth] Key registration requested for ${keyOwner} (nonce: ${nonce}) — contract not configured, logged only`);
            return {
                ok: 1,
                message: 'Key registration request received (contract not deployed — logged only)',
                keyOwner,
            };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    app.post('/api/v1/auth/revoke-key', async (
        req: FastifyRequest<{
            Body: {
                keyOwner: string;
                keyIndex: number;
                nonce: number;
                signature: string;
            };
        }>,
        reply: FastifyReply,
    ) => {
        try {
            const { keyOwner, keyIndex, nonce, signature } = req.body;
            if (!keyOwner || keyIndex === undefined || !signature) {
                return reply.status(400).send({ ok: 0, errmsg: 'Missing required fields' });
            }

            const authContract = getAuthContract();

            if (authContract.isConfigured) {
                // Live on-chain revocation via gas station meta-tx
                const result = await authContract.revokeKeyMeta(keyOwner, keyIndex, nonce, signature);
                return {
                    ok: 1,
                    message: 'Key revoked on-chain',
                    keyOwner,
                    keyIndex,
                    txHash: result.txHash,
                };
            }

            // Fallback: log-only mode
            console.log(`[Auth] Key revocation requested for ${keyOwner} (index: ${keyIndex}) — contract not configured, logged only`);
            return {
                ok: 1,
                message: 'Key revocation request received (contract not deployed — logged only)',
                keyOwner,
                keyIndex,
            };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    app.post('/api/v1/auth/rotate-key', async (
        req: FastifyRequest<{
            Body: {
                keyOwner: string;
                oldKeyIndex: number;
                newCommitment: string;
                newSalt: string;
                newStoredKey: string;
                newServerKey: string;
                nonce: number;
                signature: string;
            };
        }>,
        reply: FastifyReply,
    ) => {
        try {
            const { keyOwner, oldKeyIndex, newCommitment, newSalt, newStoredKey, newServerKey, nonce, signature } = req.body;
            if (!keyOwner || oldKeyIndex === undefined || !newCommitment || !signature) {
                return reply.status(400).send({ ok: 0, errmsg: 'Missing required fields' });
            }

            const authContract = getAuthContract();

            if (authContract.isConfigured) {
                // Atomic on-chain rotation via gas station meta-tx
                const result = await authContract.rotateKeyMeta(
                    keyOwner, oldKeyIndex, newCommitment, newSalt, newStoredKey, newServerKey, nonce, signature,
                );
                return {
                    ok: 1,
                    message: 'Key rotated on-chain',
                    keyOwner,
                    oldKeyIndex,
                    newKeyIndex: result.newKeyIndex,
                    txHash: result.txHash,
                };
            }

            // Fallback: log-only mode
            console.log(`[Auth] Key rotation requested for ${keyOwner} (oldIndex: ${oldKeyIndex}) — contract not configured, logged only`);
            return {
                ok: 1,
                message: 'Key rotation request received (contract not deployed — logged only)',
                keyOwner,
                oldKeyIndex,
            };
        } catch (err) {
            return handleError(err, reply);
        }
    });

    app.get('/api/v1/auth/keys/:address', async (
        req: FastifyRequest<{ Params: { address: string } }>,
        reply: FastifyReply,
    ) => {
        try {
            const { address } = req.params;
            if (!address || !address.startsWith('0x')) {
                return reply.status(400).send({ ok: 0, errmsg: 'Invalid address' });
            }

            const authContract = getAuthContract();

            if (authContract.isReadable) {
                // Live on-chain read of active keys + current meta-tx nonce.
                // The dashboard needs the nonce to build a valid EIP-712 signature
                // for register/revoke/rotate — it's a single incrementing counter
                // per address shared across all three operations, not the key index.
                const { activeKeys, nonce } = await authContract.getKeyState(address);
                return {
                    ok: 1,
                    address,
                    activeKeys,
                    nonce,
                };
            }

            // Fallback: empty when contract not configured
            console.log(`[Auth] Active keys requested for ${address} — contract not configured, returning empty`);
            return {
                ok: 1,
                address,
                activeKeys: [],
                nonce: 0,
            };
        } catch (err) {
            // A failed chain read is NOT "no keys". Say so, so the client can
            // show an error and retry instead of an empty list.
            if (err instanceof AuthReadError) {
                return reply.status(503).send({ ok: 0, errmsg: err.message, retryable: true });
            }
            return handleError(err, reply);
        }
    });

    // ---- Protocol Management Endpoints ----

    /**
     * Protocol enable/disable is a server-wide action affecting every user
     * (it can take a whole wire protocol offline), so it's restricted to the
     * deployer — the PlugPortAuth contract's on-chain `owner()` — rather than
     * any authenticated wallet. Returns a Fastify reply (already sent) on
     * failure, or null if the caller is verified as the deployer.
     */
    async function requireDeployer(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | null> {
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required' });
        }
        const owner = await getAuthContract().getOwner();
        if (!owner) {
            return reply.status(503).send({ ok: 0, errmsg: 'Deployer identity unavailable (auth contract not configured)' });
        }
        if (req.user.address.toLowerCase() !== owner) {
            return reply.status(403).send({ ok: 0, errmsg: 'Only the deployer can manage protocols' });
        }
        return null;
    }

    app.get('/api/v1/protocols', async (req: FastifyRequest) => {
        const deployerAddress = await getAuthContract().getOwner();
        const isDeployer = !!(req.user?.address && deployerAddress && req.user.address.toLowerCase() === deployerAddress);
        if (!options.protocolManager) {
            return { protocols: [], deployerAddress, isDeployer, ok: 1 };
        }
        return { protocols: options.protocolManager.getActiveProtocols(), deployerAddress, isDeployer, ok: 1 };
    });

    // ---- SQL Endpoint ----

    app.post('/api/v1/sql', async (
        req: FastifyRequest<{ Body: { query: string; params?: any[]; dialect?: string } }>,
        reply: FastifyReply,
    ) => {
        try {
            const { query } = req.body;
            if (!query) return reply.status(400).send({ ok: 0, errmsg: 'query required' });
            if (typeof query === 'string' && query.length > 10000) {
                return reply.status(400).send({ ok: 0, errmsg: 'query exceeds maximum length of 10000 characters' });
            }

            // Defaults to PostgreSQL for backward compatibility with callers
            // that predate dialect selection.
            const requestedDialect = (req.body.dialect || 'postgresql').toLowerCase();
            if (requestedDialect !== 'postgresql' && requestedDialect !== 'mysql') {
                return reply.status(400).send({ ok: 0, errmsg: `dialect must be "postgresql" or "mysql", got "${req.body.dialect}"` });
            }
            const dialect: SQLDialect = requestedDialect === 'mysql' ? 'MySQL' : 'PostgreSQL';

            const translator = new SQLTranslator({ dialect });
            const translated = translator.translate(query) as TranslatedQuery;
            await resolveQueryCollections(translated, namespaces, callerOf(req));

            if (translated.type === 'noop') {
                return { ok: 1, message: translated.message };
            }

            if (translated.type === 'use') {
                return { ok: 1, message: translated.message };
            }

            let result;
            if (!translated.collection && translated.type !== 'showDatabases' && translated.type !== 'join') {
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
                case 'aggregate': {
                    if (!(await checkAccess(req, reply, collection, 'read'))) return;
                    const aggSource = await store.find(collection, translated.filter || {}, {});
                    const aggDocs = executeAggregation(aggSource.cursor.firstBatch, translated.aggregation!);
                    result = { cursor: { firstBatch: aggDocs, id: 0 }, ok: 1 };
                    break;
                }
                case 'createCollection': {
                    if (!(await checkAccess(req, reply, collection, 'write'))) return;
                    await store.getOrCreateCollection(collection);
                    result = { message: 'CREATE TABLE' };
                    break;
                }
                case 'dropCollection': {
                    if (!(await checkAccess(req, reply, collection, 'write'))) return;
                    const dropped = await store.dropCollection(collection);
                    result = { dropped };
                    break;
                }
                case 'join': {
                    const plan = translated.joinPlan!;
                    const joinCollections = [
                        plan.leftCollection,
                        plan.rightCollection,
                        ...(plan.additionalJoins || []).map(j => j.rightCollection),
                    ];
                    for (const c of joinCollections) {
                        if (!(await checkAccess(req, reply, c, 'read'))) return;
                    }
                    const joinResult = await joinEngine.execute(plan, store);
                    result = { cursor: { firstBatch: joinResult.documents, id: 0 } };
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

            // Already authenticated by this route's onRequest hook (session/API key) — skip the
            // wire-level AUTH gate. A wallet works in its own keyspace, as over the wire.
            await redisServer.executeCommand(fakeSocket as any, command, true, req.user?.address);

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

        // Authenticated by the onRequest hook; a wallet subscribes to its own channels.
        const wallet = req.user?.address;
        await redisServer.executeCommand(fakeSocket as any, ['SUBSCRIBE', ...channels], true, wallet);

        const heartbeatInterval = setInterval(() => {
            if (destroyed) {
                clearInterval(heartbeatInterval);
                return;
            }
            try {
                // Send an SSE comment as a heartbeat to test TCP socket health
                reply.raw.write(`:\n\n`);
            } catch (err) {
                destroyed = true;
                clearInterval(heartbeatInterval);
                redisServer.executeCommand(fakeSocket as any, ['UNSUBSCRIBE', ...channels], true, wallet).catch(() => {});
            }
        }, 15000);

        req.raw.on('close', () => {
            destroyed = true;
            clearInterval(heartbeatInterval);
            redisServer.executeCommand(fakeSocket as any, ['UNSUBSCRIBE', ...channels], true, wallet).catch(() => {});
        });
        
        reply.hijack();
    });

    app.post('/api/v1/protocols/:name/enable', async (
        req: FastifyRequest<{ Params: { name: string } }>,
        reply: FastifyReply,
    ) => {
        if (await requireDeployer(req, reply)) return;
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
        if (await requireDeployer(req, reply)) return;
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

    app.post('/api/v1/keys/generate', WRITE_RATE_LIMIT, async (
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
        req: FastifyRequest<{ Params: { name: string }; Body: { mode: 'public' | 'private'; confirm?: boolean } }>,
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
        // Setting privacy on a name nobody owns claims it — fine for a new
        // collection, but an existing unowned one (created before ownership
        // existed) is read-only: claiming it here would let any wallet take it
        // over and lock everyone else out by making it private.
        if (!existingPrivacy && (await store.getCollection(req.params.name))) {
            return reply.status(403).send({ ok: 0, errmsg: `Collection ${req.params.name} has no owner and is read-only` });
        }
        // A new name is claimed only in the caller's own namespace.
        if (!existingPrivacy && namespaceOwner(req.params.name) !== req.user.address.toLowerCase()) {
            return reply.status(403).send({ ok: 0, errmsg: `Collection ${req.params.name} is not in your namespace` });
        }
        // A store address is never taken from the request: routing follows it,
        // and PlugPort's writer is authorised on every customer store, so a
        // caller could otherwise point their collection at someone else's store.
        const { mode } = req.body || {} as { mode: 'public' | 'private' };
        if (!mode || !['public', 'private'].includes(mode)) {
            return reply.status(400).send({ ok: 0, errmsg: 'mode must be "public" or "private"' });
        }
        const name = req.params.name;
        const owner = req.user.address.toLowerCase();
        const currentMode = existingPrivacy?.mode ?? 'public';
        const routing = 'migrateCollection' in kvStore && typeof kvStore.migrateCollection === 'function'
            ? kvStore as unknown as RoutingAdapter : null;
        try {
            // Private data goes into the owner's own store when they have an
            // active one, otherwise into the shared private store.
            let ownStore: string | undefined;
            if (mode === 'private' && privateStores) {
                const linked = await privateStores.storeFor(owner);
                if (linked && (await privateStores.verify(linked.address, owner)).ok) ownStore = linked.address;
            }
            const switchMode = async () => {
                await privacyManager.setCollectionPrivacy(name, mode, owner);
                if (ownStore) await privacyManager.setStoreAddress(name, ownStore);
            };
            if (mode === currentMode || !routing) {
                await switchMode();
                return { ok: 1, collection: name, mode };
            }

            // Changing mode moves the data (reads route by mode). Say what that
            // costs before doing it, and require an explicit confirm.
            const { documents, keys } = await routing.countCollectionKeys(name);
            const transactions = Math.ceil((keys * 2) / 50) + Math.ceil(keys / 50);
            const estimate = {
                documents,
                keys,
                transactions,
                estimatedSeconds: transactions * 3,
                destination: mode === 'public' ? 'public store' : ownStore ? `your private store ${ownStore}` : 'shared private store',
                // Switching to private can't erase what the chain already recorded.
                historyRemainsPublic: mode === 'private',
            };
            if (keys > MAX_SYNC_MIGRATION_KEYS) {
                return reply.status(413).send({ ok: 0, errmsg: `This collection has ${keys} documents and index entries; switching privacy moves up to ${MAX_SYNC_MIGRATION_KEYS} at a time. Copy the data into a new collection instead.`, estimate });
            }
            if (keys > 0 && req.body?.confirm !== true) {
                return reply.status(409).send({
                    ok: 0,
                    confirmRequired: true,
                    errmsg: `Switching ${name} to ${mode} moves ${documents} documents (${transactions} transactions, about ${estimate.estimatedSeconds}s); writes to it pause meanwhile.`
                        + (mode === 'private' ? ' Data written while it was public stays readable in the chain history.' : '')
                        + ' Resend with "confirm": true to proceed.',
                    estimate,
                });
            }
            const moved = await store.withCollectionMove(name, () =>
                routing.migrateCollection(name, mode === 'public' ? 'public' : ownStore ? { store: ownStore } : 'shared', switchMode));
            return { ok: 1, collection: name, mode, migrated: moved };
        } catch (err) {
            return handleError(err, reply);
        }
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
            if (privacy?.ownerAddress === address && !privacy.movedTo) { // an old copy being removed isn't listed twice
                userCollections.push({
                    name: namespaces.display(c.name, { wallet: address, operator: false }),
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
        // "My Requests" combines both identities this address's activity can
        // be recorded under: its wallet-linked API keys, and its own SIWE
        // wallet-session usage (normal dashboard browsing) — see the
        // `wallet:` prefix convention in the onResponse analytics hook.
        const overview = await analyticsRecorder.getOverviewForOwner([...hashes, `wallet:${address}`]);

        // Count user's collections and documents
        const allCollections = await store.listCollections();
        let userCollections = 0;
        let userDocuments = 0;
        for (const c of allCollections) {
            const privacy = await privacyManager.getCollectionPrivacy(c.name);
            if (privacy?.ownerAddress === address && !privacy.movedTo) {
                userCollections++;
                userDocuments += c.documentCount;
            }
        }

        // Keys live in two independent systems: the legacy off-chain store and
        // the on-chain PlugPortAuth registry — count both. If the chain read
        // fails, fall back to the legacy count rather than failing the whole
        // metrics page, and say the count is partial.
        let onChainKeyCount = 0;
        let apiKeysComplete = true;
        try {
            onChainKeyCount = (await getAuthContract().getActiveKeys(address)).length;
        } catch (err) {
            apiKeysComplete = false;
            console.warn('[Metrics] On-chain key count unavailable:', err instanceof Error ? err.message : err);
        }

        return {
            address,
            collections: userCollections,
            documents: userDocuments,
            apiKeys: keys.length + onChainKeyCount,
            apiKeysComplete,
            totalRequests: overview.totalRequests,
            ok: 1,
        };
    });

    // ════════════════════════════════════════════════════════
    // Contract Registration (Deployment Wizard)
    // ════════════════════════════════════════════════════════

    // The gas station a customer's own private store must name: PlugPort's
    // PrivateStore writer, which writes (and reads) private data. Used only by
    // the dashboard's "Deploy Private Store" flow. It returned the Auth
    // relayer before, so every server write to such a store would have reverted.
    app.get('/api/v1/deploy/system-gas-station', async (_req: FastifyRequest, reply: FastifyReply) => {
        if (!privateStores) {
            return reply.status(503).send({ ok: 0, errmsg: 'Per-customer private stores are not enabled on this server.' });
        }
        return { ok: 1, address: privateStores.writerAddress };
    });

    // The caller's own private store, and whether it still accepts PlugPort's writer.
    app.get('/api/v1/deploy/private-store', async (req: FastifyRequest, reply: FastifyReply) => {
        if (!req.user?.address) {
            return reply.status(401).send({ ok: 0, errmsg: 'Authentication required' });
        }
        if (!privateStores) return { ok: 1, enabled: false, store: null, status: 'none' };
        const linked = await privateStores.storeFor(req.user.address);
        if (!linked) return { ok: 1, enabled: true, store: null, status: 'none' };
        const migration = storeMigrations?.status(req.user.address) ?? null;
        try {
            const verification = await privateStores.verify(linked.address, req.user.address);
            return verification.ok
                ? { ok: 1, enabled: true, store: linked, status: 'active', migration }
                : { ok: 1, enabled: true, store: linked, status: 'detached', reason: verification.reason, migration };
        } catch (err) {
            return reply.status(503).send({ ok: 0, retryable: true, errmsg: `Could not check the store on-chain: ${err instanceof Error ? err.message : err}` });
        }
    });

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
        // A private store is checked on-chain and linked to the caller's wallet
        // before anything is recorded; it used to accept any address unchecked.
        if (contractType === 'privateStore') {
            if (!privateStores) {
                return reply.status(503).send({ ok: 0, errmsg: 'Per-customer private stores are not enabled on this server.' });
            }
            let result: Awaited<ReturnType<PrivateStoreRegistry['link']>>;
            try {
                result = await privateStores.link(req.user.address, contractAddress);
            } catch (err) {
                return reply.status(503).send({ ok: 0, retryable: true, errmsg: `Could not verify the store on-chain: ${err instanceof Error ? err.message : err}` });
            }
            if (!result.ok) return reply.status(400).send({ ok: 0, errmsg: `Store rejected: ${result.reason}` });
            // Move the wallet's private collections out of the shared store, in the background.
            void storeMigrations?.start(req.user.address);
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

    let balanceProvider: ReturnType<typeof createRpcProvider> | undefined;
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
        // Through the shared provider, so this read is rate-limited and fails over like the rest.
        balanceProvider ??= createRpcProvider(
            process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz',
            Number(process.env.MONAD_CHAIN_ID || 10143),
        );

        try {
            const balanceWei = await balanceProvider.getBalance(address);
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
            // shortMessage only: ethers' full message can quote the request URL, which may hold an API key.
            const shortMessage = (err as { shortMessage?: unknown })?.shortMessage;
            return { ok: 0, errmsg: typeof shortMessage === 'string' ? shortMessage : 'RPC request failed' };
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
    if (err instanceof CollectionBusyError) {
        return reply.status(503).send({ ok: 0, retryable: true, errmsg: err.message });
    }
    if (err instanceof StoreDetachedError) {
        return reply.status(423).send({ ok: 0, storeDetached: true, store: err.store, errmsg: err.message });
    }
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
