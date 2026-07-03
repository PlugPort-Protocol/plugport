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
        if (key.startsWith('col:')) {
            const parts = key.split(':');
            return parts[1] || null;
        }
        return null;
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

        if (options.prefix && options.prefix.startsWith('col:')) {
            const collection = this.extractCollection(options.prefix);
            if (collection && this.privacyManager) {
                const privacy = await this.privacyManager.getCollectionPrivacy(collection);
                if (privacy?.mode === 'private') {
                    return this.privateAdapter.scan(options);
                }
            }
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

        if (prefix && prefix.startsWith('col:')) {
            const collection = this.extractCollection(prefix);
            if (collection && this.privacyManager) {
                const privacy = await this.privacyManager.getCollectionPrivacy(collection);
                if (privacy?.mode === 'private') {
                    return this.privateAdapter.count(prefix);
                }
            }
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
