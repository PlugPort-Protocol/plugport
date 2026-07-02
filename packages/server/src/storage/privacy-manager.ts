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

// ---- Types ----

export interface CollectionPrivacy {
    /** Privacy mode: public (readable by all) or private (encrypted + ACL) */
    mode: 'public' | 'private';
    /** Owner's wallet address (lowercase) */
    ownerAddress: string;
    /** Deployed PlugPortPrivateStore contract address (for private collections) */
    contractAddress?: string;
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
    // I3: In-memory cache to avoid repeated KV reads (30s TTL)
    private cache: Map<string, { data: CollectionPrivacy; expires: number }> = new Map();
    private static CACHE_TTL_MS = 30_000;

    constructor(kvStore: KVAdapter, options?: { prefix?: string }) {
        this.kvStore = kvStore;
        this.prefix = options?.prefix || 'meta:privacy:';
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
        if (!data) return null;
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
            accessRoles: existing?.accessRoles || {},
            createdAt: existing?.createdAt || now,
            updatedAt: now,
        };

        await this.putPrivacy(collection, privacy);
        return privacy;
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
     * Check if an address has write access to a private collection.
     */
    async hasWriteAccess(collection: string, address: string): Promise<boolean> {
        const privacy = await this.getCollectionPrivacy(collection);

        // Public collections can be written to by anyone if no SIWE is enforced at router level,
        // but typically write requires ownership or role if it's private
        if (!privacy) return true;
        if (privacy.mode === 'public') return true;

        const normalized = address.toLowerCase();

        // Owner always has access
        if (privacy.ownerAddress === normalized) return true;

        // Check granular access
        return privacy.accessRoles[normalized] >= 2;
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

        return owned;
    }

    // ---- Internal ----

    private async putPrivacy(collection: string, privacy: CollectionPrivacy): Promise<void> {
        const key = `${this.prefix}${collection}`;
        await this.kvStore.put(key, Buffer.from(JSON.stringify(privacy)));
        // I3: Invalidate cache on write so next read fetches fresh data
        this.invalidateCache(collection);
    }
}
