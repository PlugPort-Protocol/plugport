import type { KVAdapter, KVEntry, ScanOptions } from '@plugport/shared';
import { PrivacyManager } from './privacy-manager.js';

/**
 * Routes traffic to either the public or private KV adapter based on
 * the collection's privacy mode.
 */
export class RoutingAdapter implements KVAdapter {
    private privacyManager?: PrivacyManager;

    constructor(
        private publicAdapter: KVAdapter,
        private privateAdapter: KVAdapter
    ) {}

    /**
     * Link the PrivacyManager. Must be called after PrivacyManager is instantiated.
     */
    setPrivacyManager(pm: PrivacyManager) {
        this.privacyManager = pm;
    }

    /**
     * Determine the correct adapter for a given key.
     * Metadata keys (meta:*, analytics:*) ALWAYS route to the public adapter.
     */
    private async getAdapterForKey(key: string): Promise<KVAdapter> {
        if (key.startsWith('meta:') || key.startsWith('analytics:')) {
            return this.publicAdapter;
        }

        const collection = this.extractCollection(key);
        if (!collection || !this.privacyManager) {
            return this.publicAdapter;
        }

        const privacy = await this.privacyManager.getCollectionPrivacy(collection);
        if (privacy?.mode === 'private') {
            return this.privateAdapter;
        }

        return this.publicAdapter;
    }

    /**
     * Extract collection name from a key.
     */
    private extractCollection(key: string): string | null {
        // Real storage keys are `doc:<coll>:<id>` and `idx:<coll>:<field>:…`
        // (see key-encoding.ts); `col:` is kept for the legacy/test shape. This
        // used to match only `col:`, so no real key ever routed to the private
        // adapter and private collections were written unencrypted.
        // Collection names cannot contain ':', so the second segment is exact.
        if (key.startsWith('doc:') || key.startsWith('idx:') || key.startsWith('col:')) {
            return key.split(':')[1] || null;
        }
        return null;
    }

    /** True/false when the key or prefix names a collection; null when it spans several. */
    private async isPrivatePrefix(prefix: string | undefined): Promise<boolean | null> {
        if (!prefix || !this.privacyManager) return null;
        const collection = this.extractCollection(prefix);
        if (!collection) return null;
        return (await this.privacyManager.getCollectionPrivacy(collection))?.mode === 'private';
    }

    /**
     * Move every key of a collection between the public and private adapters —
     * needed when its mode changes, because after the switch reads are routed to
     * the other adapter and would otherwise find nothing. Order: copy everything,
     * run `switchMode` (records the new mode so reads route to the copy), then
     * delete the originals. An interruption leaves duplicates rather than loss,
     * and reads never hit an adapter that has already been emptied.
     * Note the chain keeps history: values written while public stay readable in
     * old transactions; only the live copy moves.
     */
    async migrateCollection(collection: string, toPrivate: boolean, switchMode: () => Promise<void>): Promise<number> {
        if (this.publicAdapter === this.privateAdapter) {
            await switchMode();
            return 0;
        }
        const from = toPrivate ? this.publicAdapter : this.privateAdapter;
        const to = toPrivate ? this.privateAdapter : this.publicAdapter;
        let moved = 0;
        const keys: string[] = [];
        for (const prefix of [`doc:${collection}:`, `idx:${collection}:`]) {
            for (const entry of await from.scan({ prefix, limit: 100000 })) {
                await to.put(entry.key, entry.value);
                keys.push(entry.key);
                moved++;
            }
        }
        await switchMode();
        for (const key of keys) await from.delete(key);
        return moved;
    }

    async get(key: string): Promise<Buffer | null> {
        const adapter = await this.getAdapterForKey(key);
        return adapter.get(key);
    }

    async put(key: string, value: Buffer | Uint8Array): Promise<void> {
        const adapter = await this.getAdapterForKey(key);
        return adapter.put(key, value);
    }

    async delete(key: string): Promise<boolean> {
        const adapter = await this.getAdapterForKey(key);
        return adapter.delete(key);
    }

    async has(key: string): Promise<boolean> {
        const adapter = await this.getAdapterForKey(key);
        return adapter.has(key);
    }

    async scan(options: ScanOptions): Promise<KVEntry[]> {
        // Scans must be routed appropriately. If scanning metadata, use public.
        // If scanning a specific collection, route based on collection privacy.
        if (options.prefix?.startsWith('meta:') || options.prefix?.startsWith('analytics:')) {
            return this.publicAdapter.scan(options);
        }

        // A scan inside one collection goes to exactly one adapter.
        const isPrivate = await this.isPrivatePrefix(options.prefix);
        if (isPrivate !== null) {
            return (isPrivate ? this.privateAdapter : this.publicAdapter).scan(options);
        }

        // A7 fix: Global scans should merge results from both adapters
        const publicResults = await this.publicAdapter.scan(options);
        if (this.publicAdapter === this.privateAdapter) {
            return publicResults;
        }
        const privateResults = await this.privateAdapter.scan(options);
        const merged = [...publicResults, ...privateResults];
        // Respect limit if set
        if (options.limit && merged.length > options.limit) {
            return merged.slice(0, options.limit);
        }
        return merged;
    }

    async count(prefix?: string): Promise<number> {
        if (prefix?.startsWith('meta:') || prefix?.startsWith('analytics:')) {
            return this.publicAdapter.count(prefix);
        }

        const isPrivate = await this.isPrivatePrefix(prefix);
        if (isPrivate !== null) {
            return (isPrivate ? this.privateAdapter : this.publicAdapter).count(prefix);
        }

        // A7 fix: Global count should sum both adapters
        const publicCount = await this.publicAdapter.count(prefix);
        if (this.publicAdapter === this.privateAdapter) {
            return publicCount;
        }
        const privateCount = await this.privateAdapter.count(prefix);
        return publicCount + privateCount;
    }

    async clear(): Promise<void> {
        await this.publicAdapter.clear();
        // Since both might share the same underlying on-chain storage, calling clear
        // on both could be redundant, but for memory stores it's necessary.
        if (this.publicAdapter !== this.privateAdapter) {
            try {
                // If privateAdapter wraps the same base as publicAdapter, this might double-clear.
                // But generally safe if it's idempotent.
                await this.privateAdapter.clear();
            } catch (err) {
                console.warn('[RoutingAdapter] Failed to clear private adapter:', err instanceof Error ? err.message : 'unknown');
            }
        }
    }

    async batchWrite(puts: { key: string; value: Buffer | Uint8Array }[], deletes: string[]): Promise<void> {
        // Group by adapter
        const publicPuts: typeof puts = [];
        const privatePuts: typeof puts = [];
        const publicDeletes: string[] = [];
        const privateDeletes: string[] = [];

        for (const put of puts) {
            const adapter = await this.getAdapterForKey(put.key);
            if (adapter === this.privateAdapter) privatePuts.push(put);
            else publicPuts.push(put);
        }

        for (const del of deletes) {
            const adapter = await this.getAdapterForKey(del);
            if (adapter === this.privateAdapter) privateDeletes.push(del);
            else publicDeletes.push(del);
        }

        const promises: Promise<void>[] = [];

        if ((publicPuts.length > 0 || publicDeletes.length > 0) && this.publicAdapter.batchWrite) {
            promises.push(this.publicAdapter.batchWrite(publicPuts, publicDeletes));
        }

        if ((privatePuts.length > 0 || privateDeletes.length > 0) && this.privateAdapter.batchWrite) {
            promises.push(this.privateAdapter.batchWrite(privatePuts, privateDeletes));
        }

        await Promise.all(promises);
    }
}
