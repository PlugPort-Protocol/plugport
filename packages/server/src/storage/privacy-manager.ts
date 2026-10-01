// PlugPort Per-Collection Privacy Manager
// Manages privacy settings (public/private), owner tracking, and per-collection whitelists.
// All state is stored in the KV store under meta:privacy:<collection> keys.
//
// Storage format:
//   meta:privacy:<collection> → {
//     mode: 'public' | 'private',
//     ownerAddress: string,
//     contractAddress?: string,
//     whitelistedAddresses: string[],
//     createdAt: number,
//     updatedAt: number,
//   }

import type { KVAdapter } from '@plugport/shared';
import type { MetadataCipher } from './metadata-cipher.js';

/** Private collections' privacy records: `meta:pprivacy:<blinded name>`, value sealed (see metadata-cipher.ts). */
const SEALED_PREFIX = 'meta:pprivacy:';

// ---- Types ----

export interface CollectionPrivacy {
    /** Privacy mode: public (readable by all) or private (encrypted + ACL) */
    mode: 'public' | 'private';
    /** Owner's wallet address (lowercase) */
    ownerAddress: string;
    /**
     * Legacy, client-supplied and never used for routing. Before 2026-09-30 the
     * privacy endpoint accepted any value here from the request body.
     */
    contractAddress?: string;
    /**
     * The customer's own private store holding this collection's data (option B).
     * Set only by the server — after verifying the store and moving the data —
     * never from a request. Unset: private data is in the shared private store.
     */
    storeAddress?: string;
    /** Granular access roles: address -> role (1 = read, 2 = write) */
    accessRoles: Record<string, number>;
    /** When privacy settings were first created */
    createdAt: number;
    /** Last update timestamp */
    updatedAt: number;
}

// ---- Privacy Manager ----

export class PrivacyManager {
    private kvStore: KVAdapter;
    private prefix: string;
    // I3: In-memory cache to avoid repeated KV reads (30s TTL). "No settings" is
    // cached too: most collections have no record, and on the Monad adapter a
    // missing key is an uncached RPC call — the dashboard's 5s poll of
    // /api/v1/collections re-read every unowned collection from the chain.
    // Safe because every write goes through putPrivacy(), which invalidates —
    // as long as the process shares one PrivacyManager (see index.ts).
    private cache: Map<string, { data: CollectionPrivacy | null; expires: number }> = new Map();
    private static CACHE_TTL_MS = 30_000;
    // Concurrent first writes to the same new collection must not race two records into existence.
    private claims: Map<string, Promise<boolean>> = new Map();

    /** Hides private collections' records on the public contract; without it, all records are plain. */
    private cipher?: MetadataCipher;

    constructor(kvStore: KVAdapter, options?: { prefix?: string; cipher?: MetadataCipher }) {
        this.kvStore = kvStore;
        this.prefix = options?.prefix || 'meta:privacy:';
        this.cipher = options?.cipher;
    }

    private sealedKey(collection: string): string {
        return `${SEALED_PREFIX}${this.cipher!.blind(collection)}`;
    }

    /** A sealed record's contents: the record plus the name, which the key no longer carries. */
    private openSealed(value: Buffer): { collection: string; record: CollectionPrivacy } {
        return JSON.parse(this.cipher!.open(value).toString()) as { collection: string; record: CollectionPrivacy };
    }

    /** Invalidate the cache for a specific collection. */
    private invalidateCache(collection: string): void {
        this.cache.delete(collection);
    }

    /**
     * Get privacy settings for a collection.
     * Returns null if no privacy settings have been configured.
     */
    async getCollectionPrivacy(collection: string): Promise<CollectionPrivacy | null> {
        // I3: Check cache first
        const cached = this.cache.get(collection);
        if (cached && Date.now() < cached.expires) {
            return cached.data;
        }

        const key = `${this.prefix}${collection}`;
        const data = await this.kvStore.get(key);
        if (!data) {
            // A private collection's record is sealed under a blinded key.
            const sealed = this.cipher ? await this.kvStore.get(this.sealedKey(collection)) : null;
            let record: CollectionPrivacy | null = null;
            if (sealed) {
                try {
                    record = this.openSealed(sealed).record;
                } catch (err) {
                    console.warn(`[PrivacyManager] Unreadable sealed privacy record for "${collection}":`, err instanceof Error ? err.message : err);
                }
            }
            this.cache.set(collection, { data: record, expires: Date.now() + PrivacyManager.CACHE_TTL_MS });
            return record;
        }
        try {
            const parsed = JSON.parse(data.toString()) as CollectionPrivacy;
            this.cache.set(collection, { data: parsed, expires: Date.now() + PrivacyManager.CACHE_TTL_MS });
            return parsed;
        } catch (err) {
            console.warn(`[PrivacyManager] Malformed privacy data for "${collection}":`, err instanceof Error ? err.message : 'parse error');
            return null;
        }
    }

    /**
     * Set privacy mode for a collection.
     * Creates the privacy entry if it doesn't exist.
     *
     * @param collection Collection name
     * @param mode 'public' or 'private'
     * @param ownerAddress Wallet address of the owner
     * @param contractAddress Optional PlugPortPrivateStore contract address
     */
    async setCollectionPrivacy(
        collection: string,
        mode: 'public' | 'private',
        ownerAddress: string,
        contractAddress?: string,
    ): Promise<CollectionPrivacy> {
        const existing = await this.getCollectionPrivacy(collection);
        const now = Date.now();

        const privacy: CollectionPrivacy = {
            mode,
            ownerAddress: ownerAddress.toLowerCase(),
            contractAddress: contractAddress || existing?.contractAddress,
            // Where the data lives is changed only by setStoreAddress, after a
            // move. Going public ends the link: public data is in the public store.
            ...(mode === 'private' && existing?.storeAddress ? { storeAddress: existing.storeAddress } : {}),
            accessRoles: existing?.accessRoles || {},
            createdAt: existing?.createdAt || now,
            updatedAt: now,
        };

        await this.putPrivacy(collection, privacy);
        return privacy;
    }

    /**
     * Record which customer store holds a collection's data (or clear it, for
     * the shared private store). Server-side only: call it after the data is
     * actually in that store, since reads route by this field.
     */
    async setStoreAddress(collection: string, storeAddress: string | undefined): Promise<void> {
        const privacy = await this.getCollectionPrivacy(collection);
        if (!privacy) throw new Error(`Collection "${collection}" has no privacy settings configured`);
        const updated: CollectionPrivacy = { ...privacy, storeAddress, updatedAt: Date.now() };
        if (!storeAddress) delete updated.storeAddress;
        await this.putPrivacy(collection, updated);
    }

    /**
     * Record `ownerAddress` as the owner of `collection` if nobody owns it yet.
     * The first wallet to write to a collection — over any protocol — becomes its
     * owner, which is what lists it under "My Collections" in the dashboard. Only
     * ever creates a record (public mode); an existing owner or privacy setting is
     * never changed. Returns true when this call created the record.
     */
    async claimIfUnowned(
        collection: string,
        ownerAddress: string,
        options: { mode?: 'public' | 'private'; storeAddress?: string } = {},
    ): Promise<boolean> {
        if (!ownerAddress) return false;
        const inFlight = this.claims.get(collection);
        if (inFlight) return inFlight;
        const claim = (async () => {
            if (await this.getCollectionPrivacy(collection)) return false;
            // One record, written once: mode and store are decided before any data exists.
            const now = Date.now();
            const mode = options.mode ?? 'public';
            await this.putPrivacy(collection, {
                mode,
                ownerAddress: ownerAddress.toLowerCase(),
                ...(mode === 'private' && options.storeAddress ? { storeAddress: options.storeAddress } : {}),
                accessRoles: {},
                createdAt: now,
                updatedAt: now,
            });
            return true;
        })().finally(() => this.claims.delete(collection));
        this.claims.set(collection, claim);
        return claim;
    }

    /**
     * Grant an access role to an address.
     * Only the collection owner can modify access roles.
     *
     * @param collection Collection name
     * @param address Address to grant access to
     * @param role Role (1 = read, 2 = write)
     * @param callerAddress Address of the caller (must be the owner)
     */
    async grantAccess(collection: string, address: string, role: number, callerAddress: string): Promise<void> {
        const privacy = await this.getCollectionPrivacy(collection);
        if (!privacy) {
            throw new Error(`Collection "${collection}" has no privacy settings configured`);
        }
        if (privacy.ownerAddress !== callerAddress.toLowerCase()) {
            throw new Error('Only the collection owner can modify access roles');
        }
        if (role !== 1 && role !== 2) {
            throw new Error('Invalid role');
        }

        const normalized = address.toLowerCase();
        privacy.accessRoles[normalized] = role;
        privacy.updatedAt = Date.now();
        await this.putPrivacy(collection, privacy);
    }

    /**
     * Revoke all access from an address.
     * Only the collection owner can modify access roles.
     */
    async revokeAccess(collection: string, address: string, callerAddress: string): Promise<void> {
        const privacy = await this.getCollectionPrivacy(collection);
        if (!privacy) {
            throw new Error(`Collection "${collection}" has no privacy settings configured`);
        }
        if (privacy.ownerAddress !== callerAddress.toLowerCase()) {
            throw new Error('Only the collection owner can modify access roles');
        }

        const normalized = address.toLowerCase();
        delete privacy.accessRoles[normalized];
        privacy.updatedAt = Date.now();
        await this.putPrivacy(collection, privacy);
    }

    /**
     * Check if an address has read access to a private collection.
     */
    async hasReadAccess(collection: string, address: string): Promise<boolean> {
        const privacy = await this.getCollectionPrivacy(collection);

        // No privacy settings = public access
        if (!privacy || privacy.mode === 'public') return true;

        const normalized = address.toLowerCase();

        // Owner always has access
        if (privacy.ownerAddress === normalized) return true;

        // Check granular access
        return privacy.accessRoles[normalized] >= 1;
    }

    /**
     * Check if a wallet may write to a collection: its owner, or a wallet the
     * owner granted write access. "Public" means anyone can read, not anyone
     * can write — until 2026-09-30 any signed-in wallet could modify or drop
     * every non-private collection. A collection with no owner yet is not
     * writable here; the caller claims it first (see http-server checkAccess).
     */
    async hasWriteAccess(collection: string, address: string): Promise<boolean> {
        const normalized = address.toLowerCase();
        if (!normalized) return false;
        const privacy = await this.getCollectionPrivacy(collection);
        if (!privacy) return false;
        if (privacy.ownerAddress === normalized) return true;
        return (privacy.accessRoles[normalized] ?? 0) >= 2;
    }

    /**
     * List all collections owned by an address.
     */
    async listOwnedCollections(ownerAddress: string): Promise<string[]> {
        const address = ownerAddress.toLowerCase();
        const owned: string[] = [];

        const entries = await this.kvStore.scan({ prefix: this.prefix, limit: 10000 });
        for (const entry of entries) {
            try {
                const privacy = JSON.parse(entry.value.toString()) as CollectionPrivacy;
                if (privacy.ownerAddress === address) {
                    owned.push(entry.key.replace(this.prefix, ''));
                }
            } catch (err) {
                console.warn(`[PrivacyManager] Malformed privacy entry "${entry.key}":`, err instanceof Error ? err.message : 'parse error');
            }
        }
        if (this.cipher) {
            for (const entry of await this.kvStore.scan({ prefix: SEALED_PREFIX, limit: 10000 })) {
                try {
                    const { collection, record } = this.openSealed(Buffer.from(entry.value));
                    if (record.ownerAddress === address && !owned.includes(collection)) owned.push(collection);
                } catch (err) {
                    console.warn(`[PrivacyManager] Unreadable sealed privacy entry "${entry.key}":`, err instanceof Error ? err.message : err);
                }
            }
        }

        return owned;
    }

    // ---- Internal ----

    private async putPrivacy(collection: string, privacy: CollectionPrivacy): Promise<void> {
        const plainKey = `${this.prefix}${collection}`;
        if (this.cipher && privacy.mode === 'private') {
            const sealed = this.cipher.seal(Buffer.from(JSON.stringify({ collection, record: privacy })));
            await this.kvStore.put(this.sealedKey(collection), sealed);
            // A record from while it was public (or from before P9) would keep the
            // owner and access list readable; the sealed one replaces it.
            if (await this.kvStore.has(plainKey)) await this.kvStore.delete(plainKey);
        } else {
            await this.kvStore.put(plainKey, Buffer.from(JSON.stringify(privacy)));
            if (this.cipher && await this.kvStore.has(this.sealedKey(collection))) await this.kvStore.delete(this.sealedKey(collection));
        }
        // I3: Invalidate cache on write so next read fetches fresh data
        this.invalidateCache(collection);
    }
}
