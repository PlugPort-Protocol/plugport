// PlugPort Server - Main Entry Point
// Bootstraps KV adapter, document store, protocol servers, and dashboard.

import { InMemoryKVStore } from './storage/kv-adapter.js';
import { createMonadAdapter, generateKeypair } from './storage/monaddb-adapter.js';
import { DocumentStore } from './storage/document-store.js';
import { createHttpServer } from './http-server.js';
import { createWireServer } from './wire-server.js';
import { MetricsCollector } from './metrics.js';
import { ProtocolManager } from './protocols/protocol-manager.js';
import { PGServer } from './protocols/pg-server.js';
import { MySQLServer } from './protocols/mysql-server.js';
import { RedisServer } from './protocols/redis-server.js';
import { EncryptionLayer } from './storage/encryption-layer.js';
import { RoutingAdapter } from './storage/routing-adapter.js';
import { MessageBrokerAdapter } from './storage/message-broker-adapter.js';
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
 * If MONAD_RPC_URL + MONAD_PRIVATE_KEY + MONAD_CONTRACT_ADDRESS are set:
 *   - Returns MonadAdapter (production: writes cost MON gas, reads are free)
 *
 * Otherwise:
 *   - Returns InMemoryKVStore (development: free, data lost on restart)
 *
 * If MONAD_PRIVATE_KEY is present:
 *   - Wraps the adapter in RoutingAdapter + EncryptionLayer (AES-256-GCM) for parallel public/private channels
 */
export function createStorageAdapter(config: PlugPortConfig): KVAdapter & { getKeyCount(): number; getEstimatedSizeBytes(): number } {
    const rpcUrl = config.monadRpcUrl;
    const privateKey = process.env.MONAD_PRIVATE_KEY;
    const contractAddress = config.monadContractAddress;

    let baseAdapter: KVAdapter & { getKeyCount(): number; getEstimatedSizeBytes(): number };

    if (rpcUrl && privateKey && contractAddress) {
        console.log('  [Storage] Mode: Monad Smart Contract (Production)');
        baseAdapter = createMonadAdapter({
            rpcUrl,
            chainId: config.monadChainId || 10143,
            privateKey,
            contractAddress,
        });
        console.log(`  [Storage] Chain: Monad Testnet (ID: ${config.monadChainId || 10143})`);
        console.log(`  [Storage] Writes cost MON gas. Reads are free.`);
    } else {
        if (rpcUrl && !privateKey) {
            console.log('  [Storage] WARNING: MONAD_RPC_URL is set but MONAD_PRIVATE_KEY is missing.');
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

    // Wrap with encryption routing layer if private key is present
    if (privateKey) {
        console.log('  [Storage] Cryptography: ENABLED (AES-256-GCM, client-side)');
        console.log('  [Storage] Parallel Channels Active (Public & Private).');
        let privateBaseAdapter = baseAdapter;
        if (rpcUrl && privateKey && config.privateStoreContract) {
            privateBaseAdapter = createMonadAdapter({
                rpcUrl,
                chainId: config.monadChainId || 10143,
                privateKey,
                contractAddress: config.privateStoreContract,
            });
            console.log(`  [Storage] Private Channel: Isolated contract (${config.privateStoreContract})`);
        } else if (rpcUrl && privateKey) {
            console.log('  [Storage] WARNING: PRIVATE_STORE_CONTRACT missing. Using public contract for encrypted data.');
        }

        const privateAdapter = new EncryptionLayer(privateBaseAdapter, {
            privateKey,
            enabled: true,
        });
        const routingAdapter = new RoutingAdapter(baseAdapter, privateAdapter);

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

    // Initialize Protocol Manager
    const protocolManager = new ProtocolManager({
        store,
        metrics,
        kvStore,
        apiKey: config.apiKey,
        host: config.host,
    });

    // Initialize Message Broker (optional)
    let messageBroker: MessageBrokerAdapter | null = null;
    if (config.messageBrokerContract && process.env.MONAD_PRIVATE_KEY && config.monadRpcUrl) {
        messageBroker = new MessageBrokerAdapter({
            contractAddress: config.messageBrokerContract,
            wsUrl: config.monadWsUrl || config.monadRpcUrl.replace('https://', 'wss://').replace('http://', 'ws://'),
            rpcUrl: config.monadRpcUrl,
            privateKey: process.env.MONAD_PRIVATE_KEY,
            chainId: config.monadChainId || 10143,
        });
        console.log('  [PubSub] Message Broker: ENABLED (on-chain)');
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
    });

    await httpServer.listen({ port: config.httpPort, host: config.host });
    console.log(`  [HTTP] API server listening on http://${config.host}:${config.httpPort}`);
    console.log(`  [HTTP] Health: http://localhost:${config.httpPort}/health`);
    console.log(`  [HTTP] Metrics: http://localhost:${config.httpPort}/metrics`);

    // Start Wire Protocol server (MongoDB)
    if (config.protocols.mongodb.enabled) {
        const wireServer = createWireServer({
            port: config.protocols.mongodb.port,
            host: config.host,
            apiKey: config.apiKey,
            store,
            metrics,
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
    main().catch((err) => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}

