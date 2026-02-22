// PlugPort Monad Smart Contract Adapter Unit Tests
// Tests for generateKeypair, MonadAdapter, and createStorageAdapter

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    generateKeypair,
    MonadAdapter,
    createMonadAdapter,
    type MonadConfig,
} from '../storage/monaddb-adapter.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';

// =====================================================
// generateKeypair Tests
// =====================================================
describe('generateKeypair', () => {
    it('should generate a valid private key (64 hex chars)', () => {
        const wallet = generateKeypair();
        expect(wallet.privateKey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should generate a valid address (0x + 40 hex chars)', () => {
        const wallet = generateKeypair();
        expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('should generate unique keypairs on each call', () => {
        const wallet1 = generateKeypair();
        const wallet2 = generateKeypair();
        expect(wallet1.privateKey).not.toBe(wallet2.privateKey);
        expect(wallet1.address).not.toBe(wallet2.address);
    });

    it('should derive address deterministically from private key', () => {
        const wallet1 = generateKeypair();
        // Create two adapters with the same private key
        const config1: MonadConfig = {
            rpcUrl: 'http://test',
            chainId: 10143,
            privateKey: wallet1.privateKey,
            contractAddress: '0x' + '1'.repeat(40),
        };
        const config2: MonadConfig = { ...config1 };

        vi.spyOn(console, 'log').mockImplementation(() => { });
        const adapter1 = createMonadAdapter(config1);
        const adapter2 = createMonadAdapter(config2);
        expect(adapter1.getServerAddress()).toBe(adapter2.getServerAddress());
        vi.restoreAllMocks();
    });
});

// =====================================================
// createMonadAdapter Factory Tests
// =====================================================
describe('createMonadAdapter', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => { });
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const baseConfig: MonadConfig = {
        rpcUrl: 'https://testnet-rpc.monad.xyz',
        chainId: 10143,
        privateKey: 'a'.repeat(64),
        contractAddress: '0x' + '1'.repeat(40),
    };

    it('should create a MonadAdapter instance', () => {
        const adapter = createMonadAdapter(baseConfig);
        expect(adapter).toBeInstanceOf(MonadAdapter);
    });

    it('should derive a valid address from the private key', () => {
        const adapter = createMonadAdapter(baseConfig);
        const address = adapter.getServerAddress();
        expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('should produce consistent addresses for same private key', () => {
        const a1 = createMonadAdapter(baseConfig);
        const a2 = createMonadAdapter(baseConfig);
        expect(a1.getServerAddress()).toBe(a2.getServerAddress());
    });

    it('should produce different addresses for different private keys', () => {
        const a1 = createMonadAdapter(baseConfig);
        const a2 = createMonadAdapter({ ...baseConfig, privateKey: 'b'.repeat(64) });
        expect(a1.getServerAddress()).not.toBe(a2.getServerAddress());
    });

    it('should accept private key with 0x prefix', () => {
        const adapter = createMonadAdapter({ ...baseConfig, privateKey: '0x' + 'a'.repeat(64) });
        expect(adapter.getServerAddress()).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('should store the contract address', () => {
        const addr = '0x' + 'c'.repeat(40);
        const adapter = createMonadAdapter({ ...baseConfig, contractAddress: addr });
        expect(adapter.getContractAddress()).toBeTruthy();
    });
});

// =====================================================
// MonadAdapter Instance Tests
// =====================================================
describe('MonadAdapter', () => {
    let adapter: MonadAdapter;

    const config: MonadConfig = {
        rpcUrl: 'https://testnet-rpc.monad.xyz',
        chainId: 10143,
        privateKey: 'a'.repeat(64),
        contractAddress: '0x' + '1'.repeat(40),
    };

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => { });
        adapter = new MonadAdapter(config);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('Diagnostic helpers', () => {
        it('getKeyCount() should return 0 initially', () => {
            expect(adapter.getKeyCount()).toBe(0);
        });

        it('getEstimatedSizeBytes() should return 0 initially', () => {
            expect(adapter.getEstimatedSizeBytes()).toBe(0);
        });

        it('getServerAddress() should return a valid Ethereum address', () => {
            expect(adapter.getServerAddress()).toMatch(/^0x[0-9a-fA-F]{40}$/);
        });
    });

    describe('scan() with empty index', () => {
        it('should return empty array for prefix scan when no keys are indexed', async () => {
            const results = await adapter.scan({ prefix: 'doc:users:' });
            expect(results).toEqual([]);
        });
    });

    describe('batchWrite() no-op', () => {
        it('should be a no-op with empty arrays', async () => {
            // Should not throw
            await adapter.batchWrite([], []);
        });
    });
});

// =====================================================
// createStorageAdapter Tests
// =====================================================
describe('createStorageAdapter', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => { });
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = originalEnv;
        vi.restoreAllMocks();
    });

    it('should return InMemoryKVStore when no Monad config is set', async () => {
        delete process.env.MONAD_RPC_URL;
        delete process.env.MONAD_PRIVATE_KEY;
        delete process.env.MONAD_CONTRACT_ADDRESS;

        const { createStorageAdapter } = await import('../index.js');
        const config = {
            httpPort: 8080,
            wirePort: 27017,
            host: '0.0.0.0',
            maxDocumentSize: 1048576,
            maxCollections: 1000,
            logLevel: 'info' as const,
            metricsEnabled: true,
        };

        const adapter = createStorageAdapter(config);
        expect(adapter).toBeInstanceOf(InMemoryKVStore);
    });

    it('should return InMemoryKVStore when only RPC URL is set (missing key)', async () => {
        delete process.env.MONAD_PRIVATE_KEY;
        delete process.env.MONAD_CONTRACT_ADDRESS;

        const { createStorageAdapter } = await import('../index.js');
        const config = {
            httpPort: 8080,
            wirePort: 27017,
            host: '0.0.0.0',
            maxDocumentSize: 1048576,
            maxCollections: 1000,
            logLevel: 'info' as const,
            metricsEnabled: true,
            monadRpcUrl: 'https://testnet-rpc.monad.xyz',
        };

        const adapter = createStorageAdapter(config);
        expect(adapter).toBeInstanceOf(InMemoryKVStore);
    });

    it('should return InMemoryKVStore when contract address is missing', async () => {
        process.env.MONAD_PRIVATE_KEY = 'a'.repeat(64);

        const { createStorageAdapter } = await import('../index.js');
        const config = {
            httpPort: 8080,
            wirePort: 27017,
            host: '0.0.0.0',
            maxDocumentSize: 1048576,
            maxCollections: 1000,
            logLevel: 'info' as const,
            metricsEnabled: true,
            monadRpcUrl: 'https://testnet-rpc.monad.xyz',
            monadChainId: 10143,
        };

        const adapter = createStorageAdapter(config);
        expect(adapter).toBeInstanceOf(InMemoryKVStore);
    });

    it('should return MonadAdapter when all config values are set', async () => {
        process.env.MONAD_PRIVATE_KEY = 'a'.repeat(64);

        const { createStorageAdapter } = await import('../index.js');
        const config = {
            httpPort: 8080,
            wirePort: 27017,
            host: '0.0.0.0',
            maxDocumentSize: 1048576,
            maxCollections: 1000,
            logLevel: 'info' as const,
            metricsEnabled: true,
            monadRpcUrl: 'https://testnet-rpc.monad.xyz',
            monadChainId: 10143,
            monadContractAddress: '0x' + '1'.repeat(40),
        };

        const adapter = createStorageAdapter(config);
        expect(adapter).toBeInstanceOf(MonadAdapter);
    });

    it('MonadAdapter from factory should have correct address format', async () => {
        process.env.MONAD_PRIVATE_KEY = 'a'.repeat(64);

        const { createStorageAdapter } = await import('../index.js');
        const config = {
            httpPort: 8080,
            wirePort: 27017,
            host: '0.0.0.0',
            maxDocumentSize: 1048576,
            maxCollections: 1000,
            logLevel: 'info' as const,
            metricsEnabled: true,
            monadRpcUrl: 'https://testnet-rpc.monad.xyz',
            monadChainId: 10143,
            monadContractAddress: '0x' + '1'.repeat(40),
        };

        const adapter = createStorageAdapter(config) as MonadAdapter;
        expect(adapter.getServerAddress()).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });
});
