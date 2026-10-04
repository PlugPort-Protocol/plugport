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

import type { RegistryCodec } from './encryption-layer.js';
import { ethers } from 'ethers';
import { sendContractTx, confirmTx } from './tx-sequencer.js';
import { createRpcProvider } from './rpc-provider.js';
import { readKeyIndexSnapshot, writeKeyIndexSnapshot, snapshotPath } from './key-index-snapshot.js';
import type { KVAdapter, KVEntry, ScanOptions } from '@plugport/shared';
import { PLUGPORT_STORE_ABI } from './contract-abi.js';

// ---- Types ----

export interface MonadConfig {
    /**
     * Encrypts the plaintext keys written to the registry log. Set this for a
     * private contract: registry entries contain document ids and indexed field
     * values, which would otherwise sit in the clear next to encrypted documents.
     */
    registryCodec?: RegistryCodec;
    /** Monad testnet RPC URL */
    rpcUrl: string;
    /** Chain ID (10143 for Monad testnet) */
    chainId: number;
    /** Hex private key (64 chars, no 0x prefix) */
    privateKey: string;
    /** Deployed PlugPortStore contract address */
    contractAddress: string;
    /**
     * Directory for key-index snapshots (see key-index-snapshot.ts). Unset: no
     * snapshots, so every start replays the whole key-registry log.
     */
    snapshotDir?: string;
}

const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

// ---- Key Hashing ----

/**
 * Hash a string key to bytes32 for on-chain storage.
 * Uses keccak256(utf8) which matches Solidity's keccak256(abi.encodePacked(key)).
 */
function hashKey(key: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(key));
}

// ---- Key Registry (Append-Only Log) ----
//
// keccak256 is one-way, so once a string key like "doc:users:abc123" only
// exists as a hash on-chain, there is no way to recover it — the contract's
// own key registry (getKeys/getRegistryLength) only ever holds hashes.
// Without the original strings, prefix scans (collection listings, find(),
// index lookups) can't work after a restart, because there's nothing to
// match a prefix against.
//
// Fix: maintain a small append-only log of plaintext keys, itself stored
// through the exact same put/get the contract already exposes for any other
// value — no contract changes needed. Each new key gets one permanent,
// individually-addressed entry (`meta:kv-registry:{seq}` -> plaintext key
// bytes) instead of one shared blob being rewritten on every write, so
// writes stay O(1) instead of the log getting more expensive to write as it
// grows. Deletions are not removed from the log (ghost entries are cheap and
// simple to filter); a replayed entry whose underlying key no longer exists
// is just skipped when rebuilding the index at startup.
const REGISTRY_ENTRY_PREFIX = 'meta:kv-registry:';

function registryEntryKey(seq: number): string {
    return `${REGISTRY_ENTRY_PREFIX}${seq}`;
}

/**
 * Retry a flaky RPC call with a short backoff. testnet-rpc.monad.xyz is a
 * shared public endpoint that occasionally fails individual calls under
 * concurrent load with a generic "missing revert data" error — an RPC-layer
 * failure, not a genuine contract revert — so a blind retry is the right
 * response rather than treating it as a real error immediately.
 */
// Exported so retry behavior can be unit-tested directly, without needing
// to mock ethers.Contract's RPC calls end-to-end.
export async function withRetry<T>(fn: () => Promise<T>, attempts = 5, baseDelayMs = 400): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (i < attempts - 1) {
                await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
            }
        }
    }
    throw lastErr;
}

/** Lightweight async mutex — same pattern already used in document-store.ts */
class Mutex {
    private mutex = Promise.resolve();

    lock(): Promise<() => void> {
        let begin: (unlock: () => void) => void;
        this.mutex = this.mutex.then(() => new Promise(begin));
        return new Promise((res) => { begin = res; });
    }
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

    private registryCodec?: RegistryCodec;

    /** Local read cache for recently accessed values */
    private readCache: Map<string, Buffer> = new Map();

    /**
     * Uncached reads currently in flight, by key. Concurrent callers asking for
     * the same key share one RPC round trip — after a restart every dashboard
     * poll scans the same `meta:collection:*` keys before any of them is cached.
     */
    private pendingReads: Map<string, Promise<Buffer | null>> = new Map();

    /** In-flight/completed key-registry load, single-flight across concurrent callers */
    private indexLoadPromise: Promise<void> | null = null;

    /** Next free sequence number in the append-only key registry log */
    private registryCount = 0;

    /** Serializes registry sequence-number allocation across concurrent writes */
    private registryMutex = new Mutex();

    /** Where this contract's key-index snapshot lives, when snapshots are enabled. */
    private snapshotFile?: string;
    private contractAddress: string;
    /** Log position the last saved (or loaded) snapshot covers; -1 = none. */
    private snapshotUpTo = -1;

    constructor(config: MonadConfig) {
        this.registryCodec = config.registryCodec;
        this.contractAddress = config.contractAddress;
        if (config.snapshotDir) {
            this.snapshotFile = snapshotPath(config.snapshotDir, config.chainId, config.contractAddress);
            const timer = setInterval(() => { void this.saveKeyIndexSnapshot(); }, SNAPSHOT_INTERVAL_MS);
            timer.unref?.();
        }
        // Shares the process-wide RPC rate limit — see rpc-provider.ts.
        this.provider = createRpcProvider(config.rpcUrl, config.chainId, { name: 'monad-testnet' });

        const pk = config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`;
        this.wallet = new ethers.Wallet(pk, this.provider);

        this.contract = new ethers.Contract(
            config.contractAddress,
            PLUGPORT_STORE_ABI,
            this.wallet,
        );

        // Host only: provider URLs carry the API key in the path.
        console.log(`  [Monad] Connected to ${new URL(config.rpcUrl).host} (chain ${config.chainId})`);
        console.log(`  [Monad] Wallet: ${this.wallet.address}`);
        console.log(`  [Monad] Contract: ${config.contractAddress}`);

        // Warm the key registry in the background so it's typically ready
        // before the first real request, rather than only loading lazily on
        // first scan/put (which would still work correctly, just with one
        // slower first call).
        this.ensureKeyIndex().catch((err) => {
            console.warn('[MonadAdapter] Background key registry warm-up failed:', err instanceof Error ? err.message : 'unknown error');
        });
    }

    // ---- Key Index Management ----

    /**
     * Load the plaintext key registry from chain into the local index.
     * Single-flight: concurrent callers during startup all await the same
     * in-progress load rather than each kicking off their own replay.
     */
    private async ensureKeyIndex(): Promise<void> {
        if (!this.indexLoadPromise) {
            this.indexLoadPromise = this.loadKeyIndexFromChain();
        }
        return this.indexLoadPromise;
    }

    /**
     * Find how many registry entries exist by probing for the first missing
     * one — exponential search followed by binary search, so this stays fast
     * even as the registry grows, without needing a separately-stored counter
     * (which would cost an extra write on every new key).
     */
    private async findRegistryCount(): Promise<number> {
        const existsAt = (i: number) => withRetry(() => this.contract.exists(hashKey(registryEntryKey(i))));

        if (!(await existsAt(0))) return 0;

        let lo = 0;
        let hi = 1;
        while (await existsAt(hi)) {
            lo = hi;
            hi *= 2;
        }
        // Entry at `lo` exists, entry at `hi` doesn't — binary search the gap.
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (await existsAt(mid)) lo = mid; else hi = mid;
        }
        return lo + 1;
    }

    /**
     * Replays one registry entry, populating keyIndex if the underlying key
     * is still live. Returns true on success (including "was a ghost entry,
     * correctly skipped"), false if the RPC calls failed after retries.
     */
    private async replayRegistryEntry(seq: number, attempts: number, baseDelayMs: number): Promise<boolean> {
        try {
            const entryHash = hashKey(registryEntryKey(seq));
            const rawKey: string = await withRetry(() => this.contract.get(entryHash), attempts, baseDelayMs);
            if (!rawKey || rawKey === '0x') return true;
            const stored = Buffer.from(ethers.getBytes(rawKey));
            const plaintextKey = (this.registryCodec ? this.registryCodec.decode(stored) : stored).toString('utf-8');

            // Skip ghost entries — the underlying key was since deleted.
            const stillLive = await withRetry(() => this.contract.exists(hashKey(plaintextKey)), attempts, baseDelayMs);
            if (stillLive) {
                this.keyIndex.set(plaintextKey, hashKey(plaintextKey));
            }
            return true;
        } catch (err) {
            console.warn(`[MonadAdapter] Failed to replay registry entry ${seq} after retries:`, err instanceof Error ? err.message : 'unknown error');
            return false;
        }
    }

    private async loadKeyIndexFromChain(): Promise<void> {
        try {
            const count = await this.findRegistryCount();

            // Start from the snapshot when there is a usable one: only log entries
            // written after it need replaying. One that claims more entries than
            // the chain has belongs to something else and is ignored.
            let first = 0;
            if (this.snapshotFile) {
                const snapshot = await readKeyIndexSnapshot(this.snapshotFile, this.contractAddress, this.registryCodec);
                if (snapshot && snapshot.upTo <= count) {
                    for (const key of snapshot.keys) this.keyIndex.set(key, hashKey(key));
                    first = snapshot.upTo;
                    this.snapshotUpTo = snapshot.upTo;
                    console.log(`  [Monad] Key index snapshot loaded: ${snapshot.keys.length} keys, log entries 0-${snapshot.upTo - 1}`);
                } else if (snapshot) {
                    console.warn(`  [Monad] Ignoring key index snapshot: it covers ${snapshot.upTo} log entries but the chain has ${count}`);
                }
            }
            // testnet-rpc.monad.xyz is a shared public endpoint that rate-limits
            // under bursts of concurrent calls — a wide Promise.all here silently
            // dropped most entries (observed: 12/14 failed with "missing revert
            // data", an RPC-layer failure, not a genuine contract revert) rather
            // than throwing something actionable. Keep concurrency modest and
            // retry transient failures instead of just logging and moving on.
            const CONCURRENCY = 5;
            // Registry replay only runs once at startup, so it's worth
            // spending more retry budget per call here than the general
            // withRetry() default (5 attempts/400ms) — a key that fails to
            // replay stays completely undiscoverable via scan()/find() until
            // the next restart.
            const ATTEMPTS = 8;
            const BASE_DELAY_MS = 500;
            let failedSeqs: number[] = [];

            for (let start = first; start < count; start += CONCURRENCY) {
                const end = Math.min(start + CONCURRENCY, count);
                const seqRange = Array.from({ length: end - start }, (_, i) => start + i);

                const outcomes = await Promise.all(
                    seqRange.map((seq) => this.replayRegistryEntry(seq, ATTEMPTS, BASE_DELAY_MS)),
                );
                outcomes.forEach((ok, i) => { if (!ok) failedSeqs.push(seqRange[i]); });
            }

            // Give failed entries one more chance, serially and with a longer
            // backoff, once the initial concurrent burst (the likely cause of
            // rate-limiting) has finished — this recovers entries that failed
            // only because they landed in a busy window, not because the RPC
            // is down entirely.
            if (failedSeqs.length > 0) {
                console.warn(`  [Monad] Retrying ${failedSeqs.length} registry entries that failed initial replay: [${failedSeqs.join(', ')}]`);
                const stillFailed: number[] = [];
                for (const seq of failedSeqs) {
                    const ok = await this.replayRegistryEntry(seq, ATTEMPTS, BASE_DELAY_MS);
                    if (!ok) stillFailed.push(seq);
                }
                failedSeqs = stillFailed;
            }

            this.registryCount = count;
            if (failedSeqs.length > 0) {
                console.warn(`  [Monad] Key registry replay: ${failedSeqs.length}/${count} entries failed after retries — those keys stay undiscoverable until next successful restart or a fresh write: [${failedSeqs.join(', ')}]`);
            }
            console.log(`  [Monad] Key registry replayed: ${count} logged, ${count - first} replayed, ${this.keyIndex.size} live keys recovered`);
            // A snapshot after failed entries would mark them as covered and they
            // would never be retried; the next start does a full replay instead.
            if (failedSeqs.length === 0) await this.writeKeyIndexSnapshot();
        } catch (err) {
            console.warn('[MonadAdapter] Failed to load key registry (contract may not be deployed):', err instanceof Error ? err.message : 'unknown error');
        }
    }

    /**
     * Append a newly-seen plaintext key to the registry log, returning the
     * put entry to include in the same on-chain transaction as the real
     * write — so registering a key never costs a separate transaction.
     * Returns null for keys that don't need registering (already known, or
     * the registry's own internal bookkeeping keys).
     */
    private async reserveRegistryEntry(key: string): Promise<{ key: string; value: Buffer } | null> {
        if (this.keyIndex.has(key) || key.startsWith(REGISTRY_ENTRY_PREFIX)) return null;

        const unlock = await this.registryMutex.lock();
        try {
            if (this.keyIndex.has(key)) return null; // lost the race, already registered
            const seq = this.registryCount++;
            // Indexed as soon as its log entry is reserved, under the same lock: a
            // snapshot covering entry `seq` must contain the key, and a second
            // concurrent write of the same key must not reserve another entry.
            // A failed write removes it again.
            this.keyIndex.set(key, hashKey(key));
            const plain = Buffer.from(key, 'utf-8');
            return { key: registryEntryKey(seq), value: this.registryCodec ? this.registryCodec.encode(plain) : plain };
        } finally {
            unlock();
        }
    }

    // ---- Reads (Free — no gas) ----

    async get(key: string): Promise<Buffer | null> {
        // Check cache first
        if (this.readCache.has(key)) {
            return this.readCache.get(key)!;
        }

        const pending = this.pendingReads.get(key);
        if (pending) return pending;
        const read: Promise<Buffer | null> = this.readFromChain(key).then((buf) => {
            // A write to this key while the read was in flight drops it from
            // pendingReads (forgetPendingRead) — don't cache the older value.
            if (this.pendingReads.get(key) === read) {
                this.pendingReads.delete(key);
                if (buf) {
                    this.readCache.set(key, buf);
                    this.keyIndex.set(key, hashKey(key));
                }
            }
            return buf;
        }, (err) => {
            if (this.pendingReads.get(key) === read) this.pendingReads.delete(key);
            throw err;
        });
        this.pendingReads.set(key, read);
        return read;
    }

    /** A write supersedes any read of the same key that is still in flight. */
    private forgetPendingRead(key: string): void {
        this.pendingReads.delete(key);
    }

    private async readFromChain(key: string): Promise<Buffer | null> {
        try {
            const hash = hashKey(key);
            // testnet-rpc.monad.xyz occasionally fails an individual call
            // with a transient "missing revert data" RPC-layer error under
            // load — previously unprotected here, which meant a live
            // document could silently vanish from scan()/find() results
            // (scan() drops any key whose get() comes back null) even
            // though it genuinely still existed on chain. Same withRetry()
            // treatment already used for key-registry replay.
            const exists = await withRetry(() => this.contract.exists(hash));
            if (!exists) return null;

            const value: string = await withRetry(() => this.contract.get(hash));
            if (!value || value === '0x') return null;

            return Buffer.from(ethers.getBytes(value));
        } catch (err) {
            console.warn(`[MonadAdapter] RPC read failed for key "${key}" after retries:`, err instanceof Error ? err.message : 'unknown');
            return null;
        }
    }

    async has(key: string): Promise<boolean> {
        if (this.readCache.has(key)) return true;

        try {
            const hash = hashKey(key);
            return await withRetry(() => this.contract.exists(hash));
        } catch (err) {
            console.warn(`[MonadAdapter] RPC exists check failed for key "${key}" after retries:`, err instanceof Error ? err.message : 'unknown');
            return false;
        }
    }

    async scan(options: ScanOptions): Promise<KVEntry[]> {
        await this.ensureKeyIndex();
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
            } catch (err) {
                console.warn('[MonadAdapter] keyCount() RPC failed:', err instanceof Error ? err.message : 'unknown error');
                return 0;
            }
        }

        // Count keys matching prefix in local index
        await this.ensureKeyIndex();
        let c = 0;
        for (const [key] of this.keyIndex) {
            if (key.startsWith('0x') && key.length === 66) continue;
            if (key.startsWith(prefix)) c++;
        }
        return c;
    }

    // ---- Writes (Require MON gas) ----

    async put(key: string, value: Buffer | Uint8Array): Promise<void> {
        await this.ensureKeyIndex();

        const hash = hashKey(key);
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const hexValue = ethers.hexlify(buf);

        // If this key hasn't been seen before, bundle a registry-log entry
        // into the *same* transaction so it never costs an extra tx — that's
        // what makes this key discoverable again after a restart.
        const registryEntry = await this.reserveRegistryEntry(key);

        try {
            if (registryEntry) {
                const tx = await sendContractTx(this.wallet, () => this.contract.batchWrite.populateTransaction(
                    [hash, hashKey(registryEntry.key)],
                    [hexValue, ethers.hexlify(registryEntry.value)],
                    [],
                ));
                await confirmTx(tx);
            } else {
                const tx = await sendContractTx(this.wallet, () => this.contract.put.populateTransaction(hash, hexValue));
                await confirmTx(tx);
            }
        } catch (err) {
            if (registryEntry) this.keyIndex.delete(key);
            throw err;
        }

        // Update local caches
        this.forgetPendingRead(key);
        this.readCache.set(key, buf);
        this.keyIndex.set(key, hash);
    }

    async delete(key: string): Promise<boolean> {
        const hash = hashKey(key);

        try {
            const exists = await this.contract.exists(hash);
            if (!exists) return false;

            const tx = await sendContractTx(this.wallet, () => this.contract.del.populateTransaction(hash));
            await confirmTx(tx);

            // Update local caches
            this.forgetPendingRead(key);
            this.readCache.delete(key);
            this.keyIndex.delete(key);

            return true;
        } catch (err) {
            console.warn(`[MonadAdapter] Delete failed for key "${key}":`, err instanceof Error ? err.message : 'unknown');
            return false;
        }
    }

    async clear(): Promise<void> {
        await this.ensureKeyIndex();
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
                const tx = await sendContractTx(this.wallet, () => this.contract.batchWrite.populateTransaction([], [], batch));
                await confirmTx(tx);
            }
        }

        this.pendingReads.clear();
        this.readCache.clear();
        this.keyIndex.clear();
    }

    // ---- Batch Operations ----

    async batchWrite(puts: { key: string; value: Buffer | Uint8Array }[], deletes: string[]): Promise<void> {
        if (puts.length === 0 && deletes.length === 0) return;

        await this.ensureKeyIndex();

        const putKeys: string[] = [];
        const putValues: string[] = [];
        // Parallel to putKeys/putValues: which caller-facing `puts[]` key each
        // entry belongs to, or null for a registry-bookkeeping entry (those
        // aren't real caller data, so a failed write doesn't need to revert
        // any cache for them — an orphaned registry entry from a failed/
        // retried write is harmless, since replay skips entries whose
        // underlying key doesn't actually exist).
        const putOwners: (string | null)[] = [];
        const deleteKeys: string[] = [];

        for (const { key, value } of puts) {
            const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);

            // Reserve a registry-log entry *before* marking the key as known,
            // so it rides along in the same transaction as the real write.
            const registryEntry = await this.reserveRegistryEntry(key);
            if (registryEntry) {
                putKeys.push(hashKey(registryEntry.key));
                putValues.push(ethers.hexlify(registryEntry.value));
                putOwners.push(null);
            }

            putKeys.push(hashKey(key));
            putValues.push(ethers.hexlify(buf));
            putOwners.push(key);

            // Update local caches
            this.forgetPendingRead(key);
            this.readCache.set(key, buf);
            this.keyIndex.set(key, hashKey(key));
        }

        for (const key of deletes) {
            deleteKeys.push(hashKey(key));
            this.forgetPendingRead(key);
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
                const tx = await sendContractTx(this.wallet, () => this.contract.batchWrite.populateTransaction(batchPutKeys, batchPutValues, batchDeleteKeys));
                await confirmTx(tx);
            } catch (err) {
                // Revert local caches for the real (non-bookkeeping) puts in this chunk
                for (let j = i; j < Math.min(i + BATCH, putOwners.length); j++) {
                    const owner = putOwners[j];
                    if (owner === null) continue;
                    this.readCache.delete(owner);
                    this.keyIndex.delete(owner);
                }
                throw err;
            }
        }
    }

    // ---- Key-index snapshots ----

    /**
     * Save the key index and the log position it covers, if snapshots are
     * enabled and anything was logged since the last one. Every key with a
     * reserved log entry below that position is already in the index (see
     * reserveRegistryEntry). A key whose write then fails may be in the
     * snapshot; it costs one wasted lookup, never a lost key.
     */
    async saveKeyIndexSnapshot(): Promise<void> {
        if (!this.snapshotFile || !this.indexLoadPromise) return;
        await this.indexLoadPromise;
        await this.writeKeyIndexSnapshot();
    }

    /** The write itself; during the load, called directly (awaiting the load would deadlock). */
    private async writeKeyIndexSnapshot(): Promise<void> {
        if (!this.snapshotFile) return;
        const upTo = this.registryCount;
        if (upTo === this.snapshotUpTo) return;
        const keys = [...this.keyIndex.keys()].filter((k) => !(k.startsWith('0x') && k.length === 66));
        try {
            await writeKeyIndexSnapshot(this.snapshotFile, this.contractAddress, { upTo, keys }, this.registryCodec);
            this.snapshotUpTo = upTo;
        } catch (err) {
            console.warn('[MonadAdapter] Could not save the key index snapshot:', err instanceof Error ? err.message : err);
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
