import type { KVAdapter, KVEntry, ScanOptions } from '@plugport/shared';
import { PrivacyManager } from './privacy-manager.js';
import type { StoreAdapterPool } from './store-adapter-pool.js';
import type { MetadataCipher } from './metadata-cipher.js';
// Writes are paused per document operation by DocumentStore.withCollectionMove;
// the per-key check below is a safety net for anything writing around it.
import { CollectionBusyError } from './document-store.js';

export { CollectionBusyError };

/** Where a collection's data lives. */
export type StorageTarget = 'public' | 'shared' | { store: string };


/**
 * A collection whose data is in a customer's own store, after the customer
 * revoked PlugPort's writer (P10). PlugPort can then neither read nor write it.
 */
export class StoreDetachedError extends Error {
    readonly storeDetached = true;
    constructor(collection: string, readonly store: string, reason: string, readonly writer?: string) {
        super(
            `Collection ${collection} is stored in your private store ${store}, and ${reason}, so PlugPort can no longer read or write it. `
            + 'Your data is still in your contract. '
            + (writer
                ? `To restore access, call transferGasStation(${writer}) on the store from its owner wallet; access resumes within a minute.`
                : 'To restore access, make PlugPort\'s writer the store\'s gas station again from its owner wallet.'),
        );
        this.name = 'StoreDetachedError';
    }
}

/** Says whether a customer store still accepts PlugPort's writer. */
export type StoreGuard = (store: string) => Promise<{ ok: true } | { ok: false; reason: string }>;

/** Collection metadata: plain for public collections, sealed under a blinded key for private ones (P9). */
const META_PREFIX = 'meta:collection:';
const SEALED_META_PREFIX = 'meta:pcollection:';

/** Entries per batch when copying or deleting during a move (MonadAdapter's batch size). */
const MIGRATION_BATCH = 50;
/** How long a move waits for writes already in progress before giving up. */
const DRAIN_TIMEOUT_MS = 60_000;

/**
 * Routes each collection's keys to the adapter holding its data:
 *   - public collections → the public store
 *   - private collections → the shared private store, or — when the owner has
 *     their own private store and the data has been moved there — that store
 *     (option B; see StoreAdapterPool). The privacy record's `storeAddress`,
 *     set only by the server, says which.
 * Metadata keys (meta:*, analytics:*) always go to the public store.
 */
export class RoutingAdapter implements KVAdapter {
    private privacyManager?: PrivacyManager;
    private stores?: StoreAdapterPool;
    /** Collections being moved: writes to them are refused. */
    private readonly migrating = new Set<string>();
    /** Writes in progress per collection, so a move can wait for them to land. */
    private readonly inflight = new Map<string, number>();
    /** Checks a customer store before use (P10); unset, stores are assumed reachable. */
    private storeGuard?: StoreGuard;
    private storeWriter?: string;
    /** Hides private collections' metadata (see metadata-cipher.ts); unset, it stays plain. */
    private cipher?: MetadataCipher;
    /** Private collections already checked for a leftover plain metadata record this process. */
    private readonly plainMetaChecked = new Set<string>();

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

    /** Refuse, with an explanation, collections whose store no longer accepts PlugPort's writer. */
    setStoreGuard(guard: StoreGuard, writer?: string) {
        this.storeGuard = guard;
        this.storeWriter = writer;
    }

    setMetadataCipher(cipher: MetadataCipher) {
        this.cipher = cipher;
    }

    /** Enable customers' own private stores. Without it, `storeAddress` is ignored. */
    setStorePool(pool: StoreAdapterPool) {
        this.stores = pool;
    }

    private resolve(target: StorageTarget): KVAdapter {
        if (target === 'public') return this.publicAdapter;
        if (target === 'shared') return this.privateAdapter;
        if (!this.stores) throw new Error('Customer private stores are not enabled on this server');
        return this.stores.get(target.store);
    }

    /** The adapter currently holding `collection`'s data. */
    private async adapterForCollection(collection: string): Promise<KVAdapter> {
        if (!this.privacyManager) return this.publicAdapter;
        const privacy = await this.privacyManager.getCollectionPrivacy(collection);
        if (privacy?.mode !== 'private') return this.publicAdapter;
        if (privacy.storeAddress && this.stores) {
            // A store whose owner cut PlugPort off reverts reads as well as writes;
            // the chain adapter would report every document as missing.
            if (this.storeGuard) {
                const check = await this.storeGuard(privacy.storeAddress);
                if (!check.ok) throw new StoreDetachedError(collection, privacy.storeAddress, check.reason, this.storeWriter);
            }
            return this.stores.get(privacy.storeAddress);
        }
        return this.privateAdapter;
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
        return collection ? this.adapterForCollection(collection) : this.publicAdapter;
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

    /** The one adapter a prefix inside a single collection lives in; null when it spans several. */
    private async adapterForPrefix(prefix: string | undefined): Promise<KVAdapter | null> {
        if (!prefix || !this.privacyManager) return null;
        const collection = this.extractCollection(prefix);
        return collection ? this.adapterForCollection(collection) : null;
    }

    /**
     * Move every key of a collection from wherever it lives now to `target` —
     * needed when its mode changes or its data moves into the owner's own store,
     * because reads are routed by the new setting and would otherwise find
     * nothing. Order: copy everything, run `switchMode` (records the new setting
     * so reads route to the copy), then delete the originals. An interruption
     * leaves duplicates rather than loss, and reads never hit an adapter that has
     * already been emptied.
     * Note the chain keeps history: values written while public stay readable in
     * old transactions; only the live copy moves.
     *
     * `true`/`false` are the older form for shared private / public.
     */
    async migrateCollection(collection: string, target: StorageTarget | boolean, switchMode: () => Promise<void>): Promise<number> {
        const to = this.resolve(target === true ? 'shared' : target === false ? 'public' : target);
        if (this.migrating.has(collection)) throw new CollectionBusyError(collection);
        // Pause writes, then let the ones already running land: one that started
        // before the copy and finished after it would otherwise be written to the
        // old location and lost when the originals are deleted.
        this.migrating.add(collection);
        try {
            await this.drain(collection);
            // The metadata record changes form (plain ↔ sealed) when the mode does.
            const metaKey = META_PREFIX + collection;
            const metadata = this.cipher ? await this.get(metaKey) : null;
            const switchAndRewriteMetadata = async () => {
                const wasSealed = await this.sealedMetaKey(metaKey);
                await switchMode();
                if (!metadata) return;
                const sealedNow = await this.sealedMetaKey(metaKey);
                if (sealedNow) {
                    this.plainMetaChecked.delete(metaKey);
                    await this.putSealedMeta(metaKey, sealedNow, metadata);
                } else if (wasSealed) {
                    await this.publicAdapter.put(metaKey, metadata);
                    await this.publicAdapter.delete(wasSealed);
                }
            };
            const from = await this.adapterForCollection(collection);
            if (from === to) {
                await switchAndRewriteMetadata();
                return 0;
            }
            const entries: KVEntry[] = [];
            for (const prefix of [`doc:${collection}:`, `idx:${collection}:`]) {
                entries.push(...await from.scan({ prefix, limit: 100000 }));
            }
            for (let i = 0; i < entries.length; i += MIGRATION_BATCH) {
                await writeBatch(to, entries.slice(i, i + MIGRATION_BATCH), []);
            }
            await switchAndRewriteMetadata();
            const keys = entries.map((e) => e.key);
            for (let i = 0; i < keys.length; i += MIGRATION_BATCH) {
                await writeBatch(from, [], keys.slice(i, i + MIGRATION_BATCH));
            }
            return entries.length;
        } finally {
            this.migrating.delete(collection);
        }
    }

    /** Keys a move of `collection` would copy (documents plus index entries), counted locally. */
    async countCollectionKeys(collection: string): Promise<{ documents: number; keys: number }> {
        const from = await this.adapterForCollection(collection);
        const documents = await from.count(`doc:${collection}:`);
        return { documents, keys: documents + await from.count(`idx:${collection}:`) };
    }

    isMigrating(collection: string): boolean {
        return this.migrating.has(collection);
    }

    private async drain(collection: string): Promise<void> {
        const deadline = Date.now() + DRAIN_TIMEOUT_MS;
        while ((this.inflight.get(collection) ?? 0) > 0) {
            if (Date.now() > deadline) throw new Error(`Writes to ${collection} did not finish within ${DRAIN_TIMEOUT_MS / 1000}s; move not started`);
            await new Promise((r) => setTimeout(r, 50));
        }
    }

    /** Refuse writes to collections being moved; count the rest until they finish. */
    private beginWrite(keys: string[]): () => void {
        const collections = new Set<string>();
        for (const key of keys) {
            const c = this.extractCollection(key);
            if (c) collections.add(c);
        }
        for (const c of collections) if (this.migrating.has(c)) throw new CollectionBusyError(c);
        for (const c of collections) this.inflight.set(c, (this.inflight.get(c) ?? 0) + 1);
        return () => {
            for (const c of collections) {
                const n = (this.inflight.get(c) ?? 1) - 1;
                if (n > 0) this.inflight.set(c, n); else this.inflight.delete(c);
            }
        };
    }

    // ---- Private collections' metadata (P9) ----

    /** The sealed key standing in for a private collection's `meta:collection:` key; null otherwise. */
    private async sealedMetaKey(key: string): Promise<string | null> {
        if (!this.cipher || !this.privacyManager || !key.startsWith(META_PREFIX)) return null;
        const collection = key.slice(META_PREFIX.length);
        const privacy = await this.privacyManager.getCollectionPrivacy(collection);
        return privacy?.mode === 'private' ? SEALED_META_PREFIX + this.cipher.blind(collection) : null;
    }

    private async putSealedMeta(plainKey: string, sealedKey: string, value: Buffer | Uint8Array): Promise<void> {
        await this.publicAdapter.put(sealedKey, this.cipher!.seal(Buffer.from(value)));
        // A plain record from while it was public, or from before P9, would keep
        // the name, document count and index fields readable. Checked once per
        // collection per process: metadata is saved on every insert.
        if (!this.plainMetaChecked.has(plainKey)) {
            if (await this.publicAdapter.has(plainKey)) await this.publicAdapter.delete(plainKey);
            this.plainMetaChecked.add(plainKey);
        }
    }

    /** Collection metadata records, with private ones unsealed and listed under their real names. */
    private async scanMetadata(options: ScanOptions): Promise<KVEntry[]> {
        const plain = await this.publicAdapter.scan(options);
        if (!this.cipher) return plain;
        const byKey = new Map(plain.map((e) => [e.key, e]));
        for (const entry of await this.publicAdapter.scan({ prefix: SEALED_META_PREFIX, limit: options.limit })) {
            try {
                const value = this.cipher.open(Buffer.from(entry.value));
                const key = META_PREFIX + (JSON.parse(value.toString()) as { name: string }).name;
                if (options.prefix && !key.startsWith(options.prefix)) continue;
                if (options.startKey && key < options.startKey) continue;
                if (options.endKey && key >= options.endKey) continue;
                byKey.set(key, { key, value }); // the sealed record wins over a leftover plain one
            } catch (err) {
                console.warn(`[RoutingAdapter] Unreadable sealed metadata "${entry.key}":`, err instanceof Error ? err.message : err);
            }
        }
        const merged = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        if (options.reverse) merged.reverse();
        return options.limit ? merged.slice(0, options.limit) : merged;
    }

    async get(key: string): Promise<Buffer | null> {
        const sealedKey = await this.sealedMetaKey(key);
        if (sealedKey) {
            const sealed = await this.publicAdapter.get(sealedKey);
            if (sealed) return this.cipher!.open(sealed);
            return this.publicAdapter.get(key); // not sealed yet (made private before P9)
        }
        const adapter = await this.getAdapterForKey(key);
        return adapter.get(key);
    }

    async put(key: string, value: Buffer | Uint8Array): Promise<void> {
        const done = this.beginWrite([key]);
        try {
            const sealedKey = await this.sealedMetaKey(key);
            if (sealedKey) return await this.putSealedMeta(key, sealedKey, value);
            const adapter = await this.getAdapterForKey(key);
            return await adapter.put(key, value);
        } finally {
            done();
        }
    }

    async delete(key: string): Promise<boolean> {
        const done = this.beginWrite([key]);
        try {
            const sealedKey = await this.sealedMetaKey(key);
            if (sealedKey) {
                const removed = await this.publicAdapter.delete(sealedKey);
                return (await this.publicAdapter.delete(key)) || removed;
            }
            const adapter = await this.getAdapterForKey(key);
            return await adapter.delete(key);
        } finally {
            done();
        }
    }

    async has(key: string): Promise<boolean> {
        const sealedKey = await this.sealedMetaKey(key);
        if (sealedKey) return (await this.publicAdapter.has(sealedKey)) || this.publicAdapter.has(key);
        const adapter = await this.getAdapterForKey(key);
        return adapter.has(key);
    }

    async scan(options: ScanOptions): Promise<KVEntry[]> {
        // Scans must be routed appropriately. If scanning metadata, use public.
        // If scanning a specific collection, route based on collection privacy.
        if (options.prefix?.startsWith(META_PREFIX)) return this.scanMetadata(options);
        if (options.prefix?.startsWith('meta:') || options.prefix?.startsWith('analytics:')) {
            return this.publicAdapter.scan(options);
        }

        // A scan inside one collection goes to exactly one adapter.
        const adapter = await this.adapterForPrefix(options.prefix);
        if (adapter) return adapter.scan(options);

        // A7 fix: Global scans merge the public and shared private stores.
        // Customers' own stores are not included: every real read goes through
        // a collection prefix, which routes to the right store above.
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
        if (prefix?.startsWith(META_PREFIX) && this.cipher) return (await this.scanMetadata({ prefix })).length;
        if (prefix?.startsWith('meta:') || prefix?.startsWith('analytics:')) {
            return this.publicAdapter.count(prefix);
        }

        const adapter = await this.adapterForPrefix(prefix);
        if (adapter) return adapter.count(prefix);

        // A7 fix: Global count sums the public and shared private stores.
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
        const done = this.beginWrite([...puts.map((p) => p.key), ...deletes]);
        try {
            await this.routeBatch(puts, deletes);
        } finally {
            done();
        }
    }

    private async routeBatch(puts: { key: string; value: Buffer | Uint8Array }[], deletes: string[]): Promise<void> {
        // One batch per destination adapter (public, shared private, or a customer store).
        const groups = new Map<KVAdapter, { puts: typeof puts; deletes: string[] }>();
        const groupFor = (adapter: KVAdapter) => {
            let group = groups.get(adapter);
            if (!group) {
                group = { puts: [], deletes: [] };
                groups.set(adapter, group);
            }
            return group;
        };
        for (const put of puts) {
            const sealedKey = await this.sealedMetaKey(put.key);
            if (sealedKey) await this.putSealedMeta(put.key, sealedKey, put.value);
            else groupFor(await this.getAdapterForKey(put.key)).puts.push(put);
        }
        for (const del of deletes) {
            const sealedKey = await this.sealedMetaKey(del);
            if (sealedKey) groupFor(this.publicAdapter).deletes.push(sealedKey, del);
            else groupFor(await this.getAdapterForKey(del)).deletes.push(del);
        }

        await Promise.all([...groups].map(([adapter, group]) => writeBatch(adapter, group.puts, group.deletes)));
    }
}

async function writeBatch(adapter: KVAdapter, puts: { key: string; value: Buffer | Uint8Array }[], deletes: string[]): Promise<void> {
    if (adapter.batchWrite) {
        await adapter.batchWrite(puts, deletes);
    } else {
        for (const { key, value } of puts) await adapter.put(key, value);
        for (const key of deletes) await adapter.delete(key);
    }
}
