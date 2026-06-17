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
    /** Whitelisted addresses that can access private data */
    whitelistedAddresses: string[];
    /** When privacy settings were first created */
    createdAt: number;
    /** Last update timestamp */
    updatedAt: number;
}

// ---- Privacy Manager ----

export class PrivacyManager {
    private kvStore: KVAdapter;
    private prefix: string;

    constructor(kvStore: KVAdapter, options?: { prefix?: string }) {
        this.kvStore = kvStore;
        this.prefix = options?.prefix || 'meta:privacy:';
    }

    /**
     * Get privacy settings for a collection.
     * Returns null if no privacy settings have been configured.
     */
    async getCollectionPrivacy(collection: string): Promise<CollectionPrivacy | null> {
        const key = `${this.prefix}${collection}`;
        const data = await this.kvStore.get(key);
        if (!data) return null;
        try {
            return JSON.parse(data.toString()) as CollectionPrivacy;
        } catch {
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
            whitelistedAddresses: existing?.whitelistedAddresses || [],
            createdAt: existing?.createdAt || now,
            updatedAt: now,
        };

        await this.putPrivacy(collection, privacy);
        return privacy;
    }

    /**
     * Add an address to a collection's whitelist.
     * Only the collection owner can modify the whitelist.
     *
     * @param collection Collection name
     * @param address Address to whitelist
     * @param callerAddress Address of the caller (must be the owner)
     */
    async addWhitelist(collection: string, address: string, callerAddress: string): Promise<void> {
        const privacy = await this.getCollectionPrivacy(collection);
        if (!privacy) {
            throw new Error(`Collection "${collection}" has no privacy settings configured`);
        }
        if (privacy.ownerAddress !== callerAddress.toLowerCase()) {
            throw new Error('Only the collection owner can modify the whitelist');
        }

        const normalized = address.toLowerCase();
        if (!privacy.whitelistedAddresses.includes(normalized)) {
            privacy.whitelistedAddresses.push(normalized);
            privacy.updatedAt = Date.now();
            await this.putPrivacy(collection, privacy);
        }
    }

    /**
     * Remove an address from a collection's whitelist.
     * Only the collection owner can modify the whitelist.
     */
    async removeWhitelist(collection: string, address: string, callerAddress: string): Promise<void> {
        const privacy = await this.getCollectionPrivacy(collection);
        if (!privacy) {
            throw new Error(`Collection "${collection}" has no privacy settings configured`);
        }
        if (privacy.ownerAddress !== callerAddress.toLowerCase()) {
            throw new Error('Only the collection owner can modify the whitelist');
        }

        const normalized = address.toLowerCase();
        privacy.whitelistedAddresses = privacy.whitelistedAddresses.filter(a => a !== normalized);
        privacy.updatedAt = Date.now();
        await this.putPrivacy(collection, privacy);
    }

    /**
     * Check if an address has access to a private collection.
     * Returns true if:
     * - The collection is public
     * - The address is the owner
     * - The address is in the whitelist
     */
    async hasAccess(collection: string, address: string): Promise<boolean> {
        const privacy = await this.getCollectionPrivacy(collection);

        // No privacy settings = public access
        if (!privacy || privacy.mode === 'public') return true;

        const normalized = address.toLowerCase();

        // Owner always has access
        if (privacy.ownerAddress === normalized) return true;

        // Check whitelist
        return privacy.whitelistedAddresses.includes(normalized);
    }

    /**
     * List all collections owned by an address.
     */
    async listOwnedCollections(ownerAddress: string): Promise<string[]> {
        const address = ownerAddress.toLowerCase();
        const owned: string[] = [];

        const entries = await this.kvStore.scan({ prefix: this.prefix });
        for (const entry of entries) {
            try {
                const privacy = JSON.parse(entry.value.toString()) as CollectionPrivacy;
                if (privacy.ownerAddress === address) {
                    owned.push(entry.key.replace(this.prefix, ''));
                }
            } catch { /* skip malformed entries */ }
        }

        return owned;
    }

    // ---- Internal ----

    private async putPrivacy(collection: string, privacy: CollectionPrivacy): Promise<void> {
        const key = `${this.prefix}${collection}`;
        await this.kvStore.put(key, Buffer.from(JSON.stringify(privacy)));
    }
}
