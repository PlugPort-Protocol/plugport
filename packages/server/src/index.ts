// PlugPort Server - Main Entry Point
// Bootstraps KV adapter, document store, protocol servers, and dashboard.

import { InMemoryKVStore } from './storage/kv-adapter.js';
import { createMonadAdapter, generateKeypair } from './storage/monaddb-adapter.js';
import { DocumentStore } from './storage/document-store.js';
import { createHttpServer } from './http-server.js';
import { createWireServer } from './wire-server.js';
import { PrivacyManager } from './storage/privacy-manager.js';
import { MetricsCollector } from './metrics.js';
import { ProtocolManager } from './protocols/protocol-manager.js';
import { PGServer } from './protocols/pg-server.js';
import { MySQLServer } from './protocols/mysql-server.js';
import { RedisServer } from './protocols/redis-server.js';
import { EncryptionLayer, createRegistryCodec, deriveStoreRootKey } from './storage/encryption-layer.js';
import { StoreAdapterPool } from './storage/store-adapter-pool.js';
import { StoreMigrations } from './storage/store-migrations.js';
import { CollectionClaims } from './storage/collection-claims.js';
import { CollectionAccess } from './storage/collection-access.js';
import { Namespaces } from './storage/namespaces.js';
import { NamespaceMigration } from './storage/namespace-migration.js';
import { WireTls } from './protocols/wire-tls.js';
import { createMetadataCipher } from './storage/metadata-cipher.js';
import { RoutingAdapter } from './storage/routing-adapter.js';
import { MessageBrokerAdapter } from './storage/message-broker-adapter.js';
import { resolveKeys, logWalletRoles, describeRoles } from './keys.js';
import { onRpcFailover, onTxFailed } from './storage/chain-events.js';
import { createRpcProvider } from './storage/rpc-provider.js';
import { startWalletBalanceMonitor } from './wallet-balance-monitor.js';
import { PrivateStoreRegistry } from './storage/private-store-registry.js';
import { Wallet } from 'ethers';
import type { PlugPortConfig, KVAdapter, ProtocolType } from '@plugport/shared';
import { DEFAULT_CONFIG } from '@plugport/shared';

function getConfig(): PlugPortConfig {
    return {
        ...DEFAULT_CONFIG,
        httpPort: parseInt(process.env.HTTP_PORT || process.env.PORT || '8080', 10),
        wirePort: parseInt(process.env.WIRE_PORT || '27017', 10),
        host: process.env.HOST || '0.0.0.0',
        apiKey: process.env.API_KEY || undefined,
        maxDocumentSize: parseInt(process.env.MAX_DOC_SIZE || String(1024 * 1024), 10),
        logLevel: (process.env.LOG_LEVEL || 'info') as PlugPortConfig['logLevel'],
        metricsEnabled: process.env.METRICS_ENABLED !== 'false',
        monadRpcUrl: process.env.MONAD_RPC_URL || undefined,
        monadChainId: process.env.MONAD_CHAIN_ID ? parseInt(process.env.MONAD_CHAIN_ID, 10) : undefined,
        monadContractAddress: process.env.MONAD_CONTRACT_ADDRESS || undefined,
        sqlStatementTimeoutMs: parseInt(process.env.SQL_STATEMENT_TIMEOUT_MS || '30000', 10),
        // Protocol ports
        protocols: {
            http: { enabled: true, port: parseInt(process.env.HTTP_PORT || process.env.PORT || '8080', 10) },
            mongodb: { enabled: process.env.MONGODB_ENABLED !== 'false', port: parseInt(process.env.WIRE_PORT || '27017', 10) },
            postgresql: { enabled: process.env.PG_ENABLED === 'true', port: parseInt(process.env.PG_PORT || '5432', 10) },
            mysql: { enabled: process.env.MYSQL_ENABLED === 'true', port: parseInt(process.env.MYSQL_PORT || '3306', 10) },
            redis: { enabled: process.env.REDIS_ENABLED === 'true', port: parseInt(process.env.REDIS_PORT || '6379', 10) },
        },
        // Private store
        privateStoreContract: process.env.PRIVATE_STORE_CONTRACT || undefined,
        whitelistAddresses: process.env.WHITELIST_ADDRESSES ? process.env.WHITELIST_ADDRESSES.split(',') : undefined,
        // Message broker
        messageBrokerContract: process.env.MESSAGEBROKER_CONTRACT_ADDRESS || undefined,
        messageBrokerGasStation: process.env.MESSAGEBROKER_GAS_STATION || undefined,
        monadWsUrl: process.env.MONAD_WS_URL || undefined,
        // Relational
        relationalContract: process.env.RELATIONAL_CONTRACT_ADDRESS || undefined,
    };
}

/**
 * Create the appropriate KV adapter based on environment configuration.
 *
 * If MONAD_RPC_URL + a store key (STORE_PRIVATE_KEY, or legacy MONAD_PRIVATE_KEY)
 * + MONAD_CONTRACT_ADDRESS are set:
 *   - Returns MonadAdapter (production: writes cost MON gas, reads are free)
 *
 * Otherwise:
 *   - Returns InMemoryKVStore (development: free, data lost on restart)
 *
 * If an encryption root is configured (ENCRYPTION_KEY, or legacy MONAD_PRIVATE_KEY):
 *   - Wraps the adapter in RoutingAdapter + EncryptionLayer (AES-256-GCM) for parallel public/private channels
 */
export function createStorageAdapter(config: PlugPortConfig): KVAdapter & { getKeyCount(): number; getEstimatedSizeBytes(): number } {
    const rpcUrl = config.monadRpcUrl;
    const keys = resolveKeys(process.env);
    const privateKey = keys.store;
    const contractAddress = config.monadContractAddress;

    let baseAdapter: KVAdapter & { getKeyCount(): number; getEstimatedSizeBytes(): number };

    if (rpcUrl && privateKey && contractAddress) {
        console.log('  [Storage] Mode: Monad Smart Contract (Production)');
        baseAdapter = createMonadAdapter({
            rpcUrl,
            chainId: config.monadChainId || 10143,
            privateKey,
            contractAddress,
            snapshotDir: process.env.KEY_INDEX_SNAPSHOT_DIR,
        });
        console.log(`  [Storage] Chain: Monad Testnet (ID: ${config.monadChainId || 10143})`);
        console.log(`  [Storage] Writes cost MON gas. Reads are free.`);
    } else {
        if (rpcUrl && !privateKey) {
            console.log('  [Storage] WARNING: MONAD_RPC_URL is set but no store key (STORE_PRIVATE_KEY / MONAD_PRIVATE_KEY) is configured.');
            console.log('  [Storage] Generate a keypair with: npx tsx -e "import { generateKeypair } from \'./src/storage/monaddb-adapter.js\'; console.log(generateKeypair())"');
            console.log('  [Storage] Falling back to in-memory storage.');
        } else if (rpcUrl && privateKey && !contractAddress) {
            console.log('  [Storage] WARNING: MONAD_CONTRACT_ADDRESS is missing.');
            console.log('  [Storage] Deploy PlugPortStore.sol via Remix and set the contract address.');
            console.log('  [Storage] Falling back to in-memory storage.');
        } else {
            console.log('  [Storage] Mode: In-Memory (Development)');
            console.log('  [Storage] Data will not persist across restarts.');
        }

        baseAdapter = new InMemoryKVStore();
    }

    // Wrap with encryption routing layer if an encryption root is configured
    if (keys.encryption) {
        console.log('  [Storage] Cryptography: ENABLED (AES-256-GCM, client-side)');
        console.log('  [Storage] Parallel Channels Active (Public & Private).');
        let privateBaseAdapter = baseAdapter;
        if (rpcUrl && keys.privateStore && config.privateStoreContract) {
            privateBaseAdapter = createMonadAdapter({
                rpcUrl,
                chainId: config.monadChainId || 10143,
                privateKey: keys.privateStore,
                contractAddress: config.privateStoreContract,
                registryCodec: createRegistryCodec(keys.encryption),
                snapshotDir: process.env.KEY_INDEX_SNAPSHOT_DIR,
            });
            console.log(`  [Storage] Private Channel: Isolated contract (${config.privateStoreContract})`);
        } else if (rpcUrl && keys.privateStore) {
            // "Private" data would then sit on the public contract (encrypted, but
            // mixed with public data and with its key log unencrypted). Acceptable
            // for local experiments, never for a real deployment.
            if (process.env.NODE_ENV === 'production') {
                throw new Error('PRIVATE_STORE_CONTRACT is not set: refusing to store private collections on the public contract in production');
            }
            console.log('  [Storage] WARNING: PRIVATE_STORE_CONTRACT missing. Using public contract for encrypted data.');
        }

        const privateAdapter = new EncryptionLayer(privateBaseAdapter, {
            privateKey: keys.encryption,
            enabled: true,
        });
        const routingAdapter = new RoutingAdapter(baseAdapter, privateAdapter);
        // Private collections' metadata is sealed under blinded keys (P9).
        routingAdapter.setMetadataCipher(createMetadataCipher(keys.encryption));

        // B4 fix: Report combined metrics from both public and private channels
        return Object.assign(routingAdapter, {
            getKeyCount: () => baseAdapter.getKeyCount() + (privateBaseAdapter !== baseAdapter ? (privateBaseAdapter as any).getKeyCount?.() || 0 : 0),
            getEstimatedSizeBytes: () => baseAdapter.getEstimatedSizeBytes() + (privateBaseAdapter !== baseAdapter ? (privateBaseAdapter as any).getEstimatedSizeBytes?.() || 0 : 0),
        });
    }

    return baseAdapter;
}

async function main() {
    const config = getConfig();

    console.log(`
  ╔══════════════════════════════════════════════════════════════╗
  ║                                                              ║
  ║   ██████╗ ██╗     ██╗   ██╗ ██████╗ ██████╗  ██████╗ ██████╗ ████████╗  ║
  ║   ██╔══██╗██║     ██║   ██║██╔════╝ ██╔══██╗██╔═══██╗██╔══██╗╚══██╔══╝  ║
  ║   ██████╔╝██║     ██║   ██║██║  ███╗██████╔╝██║   ██║██████╔╝   ██║     ║
  ║   ██╔═══╝ ██║     ██║   ██║██║   ██║██╔═══╝ ██║   ██║██╔══██╗   ██║     ║
  ║   ██║     ███████╗╚██████╔╝╚██████╔╝██║     ╚██████╔╝██║  ██║   ██║     ║
  ║   ╚═╝     ╚══════╝ ╚═════╝  ╚═════╝ ╚═╝      ╚═════╝ ╚═╝  ╚═╝   ╚═╝     ║
  ║                                                              ║
  ║       Multi-Protocol Database Middleware on Monad             ║
  ║       MongoDB · PostgreSQL · MySQL · Redis · HTTP             ║
  ║                                                              ║
  ╚══════════════════════════════════════════════════════════════╝
  `);

    // Initialize storage (auto-detects Monad contract vs In-Memory)
    const kvStore = createStorageAdapter(config);
    const store = new DocumentStore(kvStore, config.maxDocumentSize);
    const metrics = new MetricsCollector();
    // One instance for the whole process: its cache (including "no settings")
    // is only invalidated by writes made through the same instance.
    const metadataRoot = resolveKeys(process.env).encryption;
    const privacyManager = new PrivacyManager(kvStore, { cipher: metadataRoot ? createMetadataCipher(metadataRoot) : undefined });

    // Initialize Protocol Manager
    const protocolManager = new ProtocolManager({
        store,
        metrics,
        kvStore,
        apiKey: config.apiKey,
        host: config.host,
        // Deliberately does NOT fall back to API_DOMAIN — that domain is
        // typically Cloudflare-proxied (HTTP/HTTPS only), which silently
        // hangs for a real mongodb://, postgresql://, mysql:// or redis://
        // client. PUBLIC_HOSTNAME must be a DNS-only hostname (or bare IP)
        // that actually routes the raw wire-protocol ports.
        publicHost: process.env.PUBLIC_HOSTNAME || undefined,
    });

    // Initialize Message Broker (optional)
    let messageBroker: MessageBrokerAdapter | null = null;
    const walletKeys = resolveKeys(process.env);
    if (config.messageBrokerContract && walletKeys.broker && config.monadRpcUrl) {
        messageBroker = new MessageBrokerAdapter({
            contractAddress: config.messageBrokerContract,
            wsUrl: config.monadWsUrl || config.monadRpcUrl.replace('https://', 'wss://').replace('http://', 'ws://'),
            rpcUrl: config.monadRpcUrl,
            privateKey: walletKeys.broker,
            chainId: config.monadChainId || 10143,
        });
        console.log('  [PubSub] Message Broker: ENABLED (on-chain)');
    }

    const authKeysCsv = process.env.AUTH_GAS_STATION_PRIVATE_KEYS || process.env.AUTH_GAS_STATION_PRIVATE_KEY;
    logWalletRoles(walletKeys, authKeysCsv);

    // Per-customer private stores (option B): enabled when the factory is set.
    let privateStores: PrivateStoreRegistry | undefined;
    let storeMigrations: StoreMigrations | undefined;
    const factoryAddress = process.env.PRIVATE_STORE_FACTORY;
    if (factoryAddress && config.monadRpcUrl && walletKeys.privateStore) {
        const pk = walletKeys.privateStore.startsWith('0x') ? walletKeys.privateStore : `0x${walletKeys.privateStore}`;
        privateStores = new PrivateStoreRegistry(
            kvStore,
            createRpcProvider(config.monadRpcUrl, config.monadChainId || 10143),
            factoryAddress,
            new Wallet(pk).address,
        );
        console.log(`  [PrivateStores] Per-customer stores ENABLED (factory ${factoryAddress})`);

        // Customer stores are opened on first use, each with its own key derived
        // from ENCRYPTION_KEY and the store address (see deriveStoreRootKey).
        const rootKey = walletKeys.encryption;
        const rpcUrl = config.monadRpcUrl;
        if (rootKey && 'setStorePool' in kvStore && typeof kvStore.setStorePool === 'function') {
            kvStore.setStorePool(new StoreAdapterPool((storeAddress) => {
                const storeKey = deriveStoreRootKey(rootKey, storeAddress);
                return new EncryptionLayer(createMonadAdapter({
                    rpcUrl,
                    chainId: config.monadChainId || 10143,
                    privateKey: walletKeys.privateStore!,
                    contractAddress: storeAddress,
                    registryCodec: createRegistryCodec(storeKey),
                    snapshotDir: process.env.KEY_INDEX_SNAPSHOT_DIR,
                }), { privateKey: storeKey, enabled: true });
            }));
            storeMigrations = new StoreMigrations(kvStore as unknown as RoutingAdapter, privacyManager, privateStores, store);
            // A store whose owner revoked PlugPort's writer gets a clear error instead of looking empty (P10).
            const registry = privateStores;
            (kvStore as unknown as RoutingAdapter).setStoreGuard((addr) => registry.checkWriter(addr), registry.writerAddress);
        }
    }

    // New collections: private by default, in the owner's own store when active.
    const collectionClaims = new CollectionClaims(privacyManager, privateStores);
    const collectionAccess = new CollectionAccess(privacyManager, store, collectionClaims);
    // Per-wallet namespaces: find collections from before them, which resolve
    // as if already moved, and move them in the background once serving.
    const namespaces = new Namespaces(store, privacyManager);
    await namespaces.load();
    const namespaceMigration = new NamespaceMigration(store, privacyManager, namespaces);

    // Alerting signals: chain-layer failures become counters, and every
    // gas-paying wallet's balance is polled (see wallet-balance-monitor.ts).
    onRpcFailover(() => metrics.recordRpcFailover());
    onTxFailed((stage) => metrics.recordTxFailure(stage));
    if (config.monadRpcUrl) {
        try {
            const wallets = describeRoles(walletKeys, authKeysCsv).roles;
            if (wallets.length > 0) {
                startWalletBalanceMonitor(createRpcProvider(config.monadRpcUrl, config.monadChainId || 10143), wallets, metrics);
            }
        } catch (err) {
            console.warn('  [Balances] Wallet balance monitoring disabled:', err instanceof Error ? err.message : err);
        }
    }

    // Start HTTP server
    const httpServer = await createHttpServer({
        port: config.httpPort,
        host: config.host,
        apiKey: config.apiKey,
        store,
        metrics,
        kvStore,
        protocolManager,
        privacyManager,
        privateStores,
        storeMigrations,
        namespaces,
    });

    await httpServer.listen({ port: config.httpPort, host: config.host });
    console.log(`  [HTTP] API server listening on http://${config.host}:${config.httpPort}`);
    // Finish moving private data into customers' stores that a restart interrupted.
    storeMigrations?.resumeAll().catch((err) => {
        console.warn('  [StoreMigrations] Resume failed:', err instanceof Error ? err.message : err);
    });
    namespaceMigration.run().catch((err) => {
        console.warn('  [Namespaces] Migration failed:', err instanceof Error ? err.message : err);
    });
    console.log(`  [HTTP] Health: http://localhost:${config.httpPort}/health`);
    console.log(`  [HTTP] Metrics: http://localhost:${config.httpPort}/metrics`);

    // TLS on the wire ports (see protocols/wire-tls.ts): plain clients keep
    // working; MySQL and Redis wallet logins need it.
    const wireTls = WireTls.fromFiles(process.env.TLS_CERT_FILE, process.env.TLS_KEY_FILE);
    if (!wireTls) console.log('  [TLS] No TLS_CERT_FILE: wire ports are plain only');

    // Start Wire Protocol server (MongoDB)
    if (config.protocols.mongodb.enabled) {
        const wireServer = createWireServer({
            port: config.protocols.mongodb.port,
            host: config.host,
            apiKey: config.apiKey,
            store,
            metrics,
            claimCollection: (collection, owner, mode) => collectionClaims.claim(collection, owner, mode),
            access: collectionAccess,
            namespaces,
            tls: wireTls,
        });

        wireServer.listen(config.protocols.mongodb.port, config.host, () => {
            console.log(`  [MongoDB] Wire protocol listening on ${config.host}:${config.protocols.mongodb.port}`);
            console.log(`  [MongoDB] Connect: mongosh mongodb://localhost:${config.protocols.mongodb.port}`);
        });

        // Register with protocol manager (wrapping existing net.Server)
        protocolManager.register({
            name: 'mongodb',
            server: wireServer,
            port: config.protocols.mongodb.port,
            connections: 0,
            start: async () => {},  // Already started above
            stop: async () => { wireServer.close(); },
            getConnectionCount: () => 0,
        });
    }

    // Register PostgreSQL protocol server
    if (config.protocols.postgresql.enabled) {
        const pgServer = new PGServer({
            store,
            port: config.protocols.postgresql.port,
            host: config.host,
            timeoutMs: config.sqlStatementTimeoutMs,
            apiKey: config.apiKey,
            metrics,
            access: collectionAccess,
            namespaces,
            tls: wireTls,
        });
        protocolManager.register(pgServer);
        await pgServer.start();
        console.log(`  [PostgreSQL] Connect: psql postgresql://localhost:${config.protocols.postgresql.port}/plugport`);
    }

    // Register MySQL protocol server
    if (config.protocols.mysql.enabled) {
        const mysqlServer = new MySQLServer({
            store,
            port: config.protocols.mysql.port,
            host: config.host,
            timeoutMs: config.sqlStatementTimeoutMs,
            apiKey: config.apiKey,
            metrics,
            access: collectionAccess,
            namespaces,
            tls: wireTls,
        });
        protocolManager.register(mysqlServer);
        await mysqlServer.start();
        console.log(`  [MySQL] Connect: mysql -h localhost -P ${config.protocols.mysql.port}`);
    }

    // Register Redis protocol server
    if (config.protocols.redis.enabled) {
        const redisServer = new RedisServer({
            store,
            kvStore,
            port: config.protocols.redis.port,
            host: config.host,
            messageBroker,
            apiKey: config.apiKey,
            metrics,
            tls: wireTls,
        });
        protocolManager.register(redisServer);
        await redisServer.start();
        console.log(`  [Redis] Connect: redis-cli -p ${config.protocols.redis.port}`);
    }

    // Print active protocols summary
    const activeProtocols = protocolManager.getActiveProtocols();
    const enabledCount = activeProtocols.filter(p => p.enabled).length;
    console.log('');
    console.log(`  Active protocols: ${enabledCount}`);
    for (const protocol of activeProtocols) {
        if (protocol.enabled) {
            console.log(`    ✓ ${protocol.name.padEnd(12)} → ${protocol.connectionString}`);
        }
    }


    console.log('');
    console.log('  Ready to accept connections.');
    console.log('');

    // Graceful shutdown
    const shutdown = async (signal: string) => {
        console.log(`\n  Received ${signal}. Shutting down gracefully...`);
        await protocolManager.shutdown();
        await httpServer.close();
        if (messageBroker) await messageBroker.disconnect();
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.env.NODE_ENV !== 'test') {
    // A rejection nobody awaits — typically from a library's background
    // polling (ethers' block/receipt/event subscribers don't catch their own
    // RPC errors) — would otherwise exit the process and take every protocol
    // down with it over one failed RPC call. Log it and keep serving.
    process.on('unhandledRejection', (reason) => {
        console.error('[PlugPort] Unhandled promise rejection (process kept running):', reason);
    });

    main().catch((err) => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}

