// PlugPort KV Adapter - In-memory implementation mimicking MonadDb's API
// This adapter provides a sorted key-value store that preserves lexicographic ordering,
// matching MonadDb's Merkle Patricia Trie behavior for prefix scans and range queries.

import type { KVAdapter, KVEntry, ScanOptions } from '@plugport/shared';

/**
 * In-memory KV store that mimics MonadDb's storage semantics.
 * Uses a sorted array for lexicographic key ordering, enabling prefix scans
 * and range queries that mirror MonadDb's Merkle Patricia Trie behavior.
 *
 * Drop-in replacement: swap this with a real MonadDb RPC client by implementing KVAdapter.
 */
export class InMemoryKVStore implements KVAdapter {
    private store: Map<string, Buffer> = new Map();
    private sortedKeys: string[] = [];
    private dirty = false;

    private ensureSorted(): void {
        if (this.dirty) {
            this.sortedKeys = Array.from(this.store.keys()).sort();
            this.dirty = false;
        }
    }

    private binarySearch(key: string): number {
        this.ensureSorted();
        let lo = 0;
        let hi = this.sortedKeys.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.sortedKeys[mid] < key) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    async get(key: string): Promise<Buffer | null> {
        return this.store.get(key) ?? null;
    }

    async put(key: string, value: Buffer | Uint8Array): Promise<void> {
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (!this.store.has(key)) {
            this.dirty = true;
        }
        this.store.set(key, buf);
    }

    async delete(key: string): Promise<boolean> {
        const existed = this.store.delete(key);
        if (existed) this.dirty = true;
        return existed;
    }

    async has(key: string): Promise<boolean> {
        return this.store.has(key);
    }

    async scan(options: ScanOptions): Promise<KVEntry[]> {
        this.ensureSorted();
        const { prefix, startKey, endKey, limit, reverse } = options;
        const results: KVEntry[] = [];
        const effectiveLimit = limit ?? Infinity;

        let keys = this.sortedKeys;

        // Determine scan range
        let startIdx = 0;
        let endIdx = keys.length;

        if (prefix) {
            startIdx = this.binarySearch(prefix);
            const prefixEnd = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
            endIdx = this.binarySearch(prefixEnd);
        }

        if (startKey) {
            const sIdx = this.binarySearch(startKey);
            startIdx = Math.max(startIdx, sIdx);
        }

        if (endKey) {
            const eIdx = this.binarySearch(endKey);
            endIdx = Math.min(endIdx, eIdx);
        }

        if (reverse) {
            for (let i = endIdx - 1; i >= startIdx && results.length < effectiveLimit; i--) {
                const key = keys[i];
                const value = this.store.get(key)!;
                results.push({ key, value });
            }
        } else {
            for (let i = startIdx; i < endIdx && results.length < effectiveLimit; i++) {
                const key = keys[i];
                const value = this.store.get(key)!;
                results.push({ key, value });
            }
        }

        return results;
    }

    async count(prefix?: string): Promise<number> {
        if (!prefix) return this.store.size;
        this.ensureSorted();
        const startIdx = this.binarySearch(prefix);
        const prefixEnd = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
        const endIdx = this.binarySearch(prefixEnd);
        return endIdx - startIdx;
    }

    async clear(): Promise<void> {
        this.store.clear();
        this.sortedKeys = [];
        this.dirty = false;
    }

    // Diagnostic helpers
    getKeyCount(): number {
        return this.store.size;
    }

    getEstimatedSizeBytes(): number {
        let size = 0;
        for (const [key, value] of this.store) {
            size += key.length * 2 + value.length;
        }
        return size;
    }

    dump(): Map<string, Buffer> {
        return new Map(this.store);
    }
}

/**
 * Creates a KV adapter instance.
 * In production, this would connect to MonadDb via RPC.
 */
export function createKVAdapter(_endpoint?: string): KVAdapter {
    // Future: if endpoint is provided, return a MonadDbRPCAdapter
    return new InMemoryKVStore();
}
