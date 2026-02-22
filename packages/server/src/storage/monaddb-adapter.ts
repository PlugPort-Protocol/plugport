// PlugPort Monad Smart Contract Adapter
// Production KVAdapter implementation that stores data on-chain via a Solidity KV store contract.
//
// Architecture:
//   - Reads are free eth_call invocations (no gas)
//   - Writes are signed transactions that require MON for gas
//   - Keys are hashed via keccak256(utf8Key) → bytes32 for on-chain storage
//   - A local in-memory index maps string keys to bytes32 hashes for scan/prefix operations
//   - Batch writes use the contract's batchWrite() to minimize gas overhead
//
// Configuration (env vars):
//   - MONAD_RPC_URL         — Monad testnet RPC (default: https://testnet-rpc.monad.xyz)
//   - MONAD_CHAIN_ID        — Chain ID (default: 10143)
//   - MONAD_PRIVATE_KEY     — 64-char hex private key (owner wallet)
//   - MONAD_CONTRACT_ADDRESS — Deployed PlugPortStore contract address

import { ethers } from 'ethers';
import type { KVAdapter, KVEntry, ScanOptions } from '@plugport/shared';
import { PLUGPORT_STORE_ABI } from './contract-abi.js';

// ---- Types ----

export interface MonadConfig {
    /** Monad testnet RPC URL */
    rpcUrl: string;
    /** Chain ID (10143 for Monad testnet) */
    chainId: number;
    /** Hex private key (64 chars, no 0x prefix) */
    privateKey: string;
    /** Deployed PlugPortStore contract address */
    contractAddress: string;
}

// ---- Key Hashing ----

/**
 * Hash a string key to bytes32 for on-chain storage.
 * Uses keccak256(utf8) which matches Solidity's keccak256(abi.encodePacked(key)).
 */
function hashKey(key: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(key));
}

// ---- Monad Adapter ----

/**
 * Production KV adapter that stores data on Monad via a smart contract.
 *
 * Reads are free (eth_call). Writes cost MON gas.
 * The adapter maintains a local key index for string-key → hash mapping,
 * enabling prefix-based scan() operations that the on-chain contract cannot do.
 */
export class MonadAdapter implements KVAdapter {
    private provider: ethers.JsonRpcProvider;
    private wallet: ethers.Wallet;
    private contract: ethers.Contract;

    /** Local index: string key → bytes32 hash (for scan/prefix support) */
    private keyIndex: Map<string, string> = new Map();

    /** Local read cache for recently accessed values */
    private readCache: Map<string, Buffer> = new Map();

    /** Whether the key index has been loaded from chain */
    private indexLoaded = false;

    constructor(config: MonadConfig) {
        this.provider = new ethers.JsonRpcProvider(config.rpcUrl, {
            chainId: config.chainId,
            name: 'monad-testnet',
        });

        const pk = config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`;
        this.wallet = new ethers.Wallet(pk, this.provider);

        this.contract = new ethers.Contract(
            config.contractAddress,
            PLUGPORT_STORE_ABI,
            this.wallet,
        );

        console.log(`  [Monad] Connected to ${config.rpcUrl} (chain ${config.chainId})`);
        console.log(`  [Monad] Wallet: ${this.wallet.address}`);
        console.log(`  [Monad] Contract: ${config.contractAddress}`);
    }

    // ---- Key Index Management ----

    /**
     * Lazily load the on-chain key registry into our local index.
     * This only runs once on first scan/prefix operation.
     */
    private async ensureKeyIndex(): Promise<void> {
        if (this.indexLoaded) return;

        try {
            const registryLen = await this.contract.getRegistryLength();
            const totalKeys = Number(registryLen);
            const PAGE_SIZE = 500;

            for (let offset = 0; offset < totalKeys; offset += PAGE_SIZE) {
                const keys: string[] = await this.contract.getKeys(offset, PAGE_SIZE);
                for (const keyHash of keys) {
                    // We store hash → hash since we can't reverse keccak256
                    // The actual string keys will be populated on put() calls
                    if (!this.keyIndex.has(keyHash)) {
                        this.keyIndex.set(keyHash, keyHash);
                    }
                }
            }
        } catch {
            // Contract may not be deployed yet; silently ignore
        }

        this.indexLoaded = true;
    }

    // ---- Reads (Free — no gas) ----

    async get(key: string): Promise<Buffer | null> {
        // Check cache first
        if (this.readCache.has(key)) {
            return this.readCache.get(key)!;
        }

        try {
            const hash = hashKey(key);
            const exists = await this.contract.exists(hash);
            if (!exists) return null;

            const value: string = await this.contract.get(hash);
            if (!value || value === '0x') return null;

            const buf = Buffer.from(ethers.getBytes(value));
            this.readCache.set(key, buf);

            // Track in key index
            this.keyIndex.set(key, hash);

            return buf;
        } catch {
            return null;
        }
    }

    async has(key: string): Promise<boolean> {
        if (this.readCache.has(key)) return true;

        try {
            const hash = hashKey(key);
            return await this.contract.exists(hash);
        } catch {
            return false;
        }
    }

    async scan(options: ScanOptions): Promise<KVEntry[]> {
        const results: KVEntry[] = [];

        // For prefix-based scans, use the local key index
        if (options.prefix) {
            // First, try to load all keys matching a prefix from our local index
            const matchingKeys: string[] = [];
            for (const [stringKey] of this.keyIndex) {
                // Skip hash-only entries (from initial load)
                if (stringKey.startsWith('0x') && stringKey.length === 66) continue;

                if (stringKey.startsWith(options.prefix)) {
                    if (options.startKey && stringKey < options.startKey) continue;
                    if (options.endKey && stringKey >= options.endKey) continue;
                    matchingKeys.push(stringKey);
                }
            }

            // Sort keys lexicographically
            matchingKeys.sort();
            if (options.reverse) matchingKeys.reverse();

            // Apply limit
            const limit = options.limit || matchingKeys.length;
            const keysToFetch = matchingKeys.slice(0, limit);

            // Fetch values
            for (const key of keysToFetch) {
                const value = await this.get(key);
                if (value) {
                    results.push({ key, value });
                }
            }
        }

        return results;
    }

    async count(prefix?: string): Promise<number> {
        if (!prefix) {
            try {
                const count = await this.contract.keyCount();
                return Number(count);
            } catch {
                return 0;
            }
        }

        // Count keys matching prefix in local index
        let c = 0;
        for (const [key] of this.keyIndex) {
            if (key.startsWith('0x') && key.length === 66) continue;
            if (key.startsWith(prefix)) c++;
        }
        return c;
    }

    // ---- Writes (Require MON gas) ----

    async put(key: string, value: Buffer | Uint8Array): Promise<void> {
        const hash = hashKey(key);
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const hexValue = ethers.hexlify(buf);

        const tx = await this.contract.put(hash, hexValue);
        await tx.wait();

        // Update local caches
        this.readCache.set(key, buf);
        this.keyIndex.set(key, hash);
    }

    async delete(key: string): Promise<boolean> {
        const hash = hashKey(key);

        try {
            const exists = await this.contract.exists(hash);
            if (!exists) return false;

            const tx = await this.contract.del(hash);
            await tx.wait();

            // Update local caches
            this.readCache.delete(key);
            this.keyIndex.delete(key);

            return true;
        } catch {
            return false;
        }
    }

    async clear(): Promise<void> {
        // Clear all keys via batch delete
        const keys: string[] = [];
        for (const [key] of this.keyIndex) {
            if (key.startsWith('0x') && key.length === 66) continue;
            keys.push(key);
        }

        if (keys.length > 0) {
            const hashes = keys.map(hashKey);
            const BATCH = 100;

            for (let i = 0; i < hashes.length; i += BATCH) {
                const batch = hashes.slice(i, i + BATCH);
                const tx = await this.contract.batchWrite([], [], batch);
                await tx.wait();
            }
        }

        this.readCache.clear();
        this.keyIndex.clear();
    }

    // ---- Batch Operations ----

    async batchWrite(puts: { key: string; value: Buffer | Uint8Array }[], deletes: string[]): Promise<void> {
        if (puts.length === 0 && deletes.length === 0) return;

        const putKeys: string[] = [];
        const putValues: string[] = [];
        const deleteKeys: string[] = [];

        for (const { key, value } of puts) {
            const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
            putKeys.push(hashKey(key));
            putValues.push(ethers.hexlify(buf));

            // Update local caches
            this.readCache.set(key, buf);
            this.keyIndex.set(key, hashKey(key));
        }

        for (const key of deletes) {
            deleteKeys.push(hashKey(key));
            this.readCache.delete(key);
            this.keyIndex.delete(key);
        }

        // Batch in chunks to avoid gas limit
        const BATCH = 50;
        for (let i = 0; i < Math.max(putKeys.length, deleteKeys.length); i += BATCH) {
            const batchPutKeys = putKeys.slice(i, i + BATCH);
            const batchPutValues = putValues.slice(i, i + BATCH);
            const batchDeleteKeys = deleteKeys.slice(i, i + BATCH);

            try {
                const tx = await this.contract.batchWrite(batchPutKeys, batchPutValues, batchDeleteKeys);
                await tx.wait();
            } catch (err) {
                // Revert local caches for failed puts
                for (let j = i; j < Math.min(i + BATCH, puts.length); j++) {
                    this.readCache.delete(puts[j].key);
                    this.keyIndex.delete(puts[j].key);
                }
                throw err;
            }
        }
    }

    // ---- Diagnostic Helpers ----

    getKeyCount(): number {
        return this.keyIndex.size;
    }

    getEstimatedSizeBytes(): number {
        let total = 0;
        for (const [key, value] of this.readCache) {
            total += key.length + value.length;
        }
        return total;
    }

    getServerAddress(): string {
        return this.wallet.address;
    }

    getContractAddress(): string {
        return this.contract.target as string;
    }
}

// ---- Factory ----

/**
 * Create a MonadAdapter connected to a deployed PlugPortStore contract.
 */
export function createMonadAdapter(config: MonadConfig): MonadAdapter {
    return new MonadAdapter(config);
}

/**
 * Generate a new wallet keypair for Monad transactions.
 * Uses proper secp256k1 key derivation via ethers.js.
 */
export function generateKeypair(): { privateKey: string; address: string } {
    const wallet = ethers.Wallet.createRandom();
    return {
        privateKey: wallet.privateKey.slice(2), // Remove 0x prefix
        address: wallet.address,
    };
}
