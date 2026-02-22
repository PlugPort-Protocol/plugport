// PlugPort Server - Main Entry Point
// Bootstraps KV adapter, document store, HTTP API server, and wire protocol server

import { InMemoryKVStore } from './storage/kv-adapter.js';
import { createMonadAdapter, generateKeypair } from './storage/monaddb-adapter.js';
import { DocumentStore } from './storage/document-store.js';
import { createHttpServer } from './http-server.js';
import { createWireServer } from './wire-server.js';
import { MetricsCollector } from './metrics.js';
import type { PlugPortConfig, KVAdapter } from '@plugport/shared';
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
 */
export function createStorageAdapter(config: PlugPortConfig): KVAdapter & { getKeyCount(): number; getEstimatedSizeBytes(): number } {
    const rpcUrl = config.monadRpcUrl;
    const privateKey = process.env.MONAD_PRIVATE_KEY;
    const contractAddress = config.monadContractAddress;

    if (rpcUrl && privateKey && contractAddress) {
        console.log('  [Storage] Mode: Monad Smart Contract (Production)');
        const adapter = createMonadAdapter({
            rpcUrl,
            chainId: config.monadChainId || 10143,
            privateKey,
            contractAddress,
        });
        console.log(`  [Storage] Chain: Monad Testnet (ID: ${config.monadChainId || 10143})`);
        console.log(`  [Storage] Writes cost MON gas. Reads are free.`);
        return adapter;
    }

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

    return new InMemoryKVStore();
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
  ║       MongoDB-Compatible Store on Monad                      ║
  ║                                                              ║
  ╚══════════════════════════════════════════════════════════════╝
  `);

    // Initialize storage (auto-detects Monad contract vs In-Memory)
    const kvStore = createStorageAdapter(config);
    const store = new DocumentStore(kvStore, config.maxDocumentSize);
    const metrics = new MetricsCollector();

    // Start HTTP server
    const httpServer = await createHttpServer({
        port: config.httpPort,
        host: config.host,
        apiKey: config.apiKey,
        store,
        metrics,
        kvStore,
    });

    await httpServer.listen({ port: config.httpPort, host: config.host });
    console.log(`  [HTTP] API server listening on http://${config.host}:${config.httpPort}`);
    console.log(`  [HTTP] Health: http://localhost:${config.httpPort}/health`);
    console.log(`  [HTTP] Metrics: http://localhost:${config.httpPort}/metrics`);

    // Start Wire Protocol server
    const wireServer = createWireServer({
        port: config.wirePort,
        host: config.host,
        apiKey: config.apiKey,
        store,
        metrics,
    });

    wireServer.listen(config.wirePort, config.host, () => {
        console.log(`  [Wire] MongoDB protocol server listening on ${config.host}:${config.wirePort}`);
        console.log(`  [Wire] Connect: mongosh mongodb://localhost:${config.wirePort}`);
        console.log('');
        console.log('  Ready to accept connections.');
        console.log('');
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
        console.log(`\n  Received ${signal}. Shutting down gracefully...`);
        wireServer.close();
        await httpServer.close();
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
