// PlugPort API Key Manager
// Generates, validates, revokes, and manages wallet-linked API keys.
// Keys are stored as SHA-256 hashes in the KV store — raw keys are never persisted.
//
// Key format: pp_live_<32-char-hex> (production) or pp_test_<32-char-hex> (testnet)
// Storage:    meta:apikey:<sha256(raw)> → { ownerAddress, label, createdAt, permissions, rateLimit, active }
// Index:      meta:apikeys-by-owner:<address> → [hash1, hash2, ...]

import { randomBytes, createHash } from 'crypto';
import type { KVAdapter } from '@plugport/shared';

// ---- Types ----

export type ApiKeyPermission = 'read' | 'write' | 'admin' | 'all';

export interface ApiKeyMetadata {
    /** SHA-256 hash of the raw API key */
    hash: string;
    /** Owner's wallet address (lowercase) */
    ownerAddress: string;
    /** User-assigned label (e.g., "my-app-prod") */
    label: string;
    /** Key creation timestamp */
    createdAt: number;
    /** Granted permissions */
    permissions: ApiKeyPermission[];
    /** Per-key rate limit (requests per 10 seconds) */
    rateLimit: number;
    /** Whether the key is active */
    active: boolean;
}

export interface GenerateKeyResult {
    /** The raw API key (shown once, never stored) */
    apiKey: string;
    /** SHA-256 hash for future reference */
    hash: string;
    /** Key metadata */
    metadata: ApiKeyMetadata;
}

// ---- API Key Manager ----

export class ApiKeyManager {
    private kvStore: KVAdapter;
    private prefix: string;

    constructor(kvStore: KVAdapter, options?: { prefix?: string }) {
        this.kvStore = kvStore;
        this.prefix = options?.prefix || 'meta:apikey:';
    }

    /**
     * Generate a new API key linked to a wallet address.
     *
     * @param ownerAddress Wallet address (will be lowercased)
     * @param label Human-readable label for the key
     * @param permissions Array of permissions to grant
     * @param rateLimit Requests per 10 seconds (default: 100)
     * @returns The raw API key (shown once) and metadata
     */
    async generateKey(
        ownerAddress: string,
        label: string,
        permissions: ApiKeyPermission[] = ['all'],
        rateLimit: number = 100,
    ): Promise<GenerateKeyResult> {
        const address = ownerAddress.toLowerCase();
        const rawHex = randomBytes(16).toString('hex'); // 32 hex chars
        const isTestnet = process.env.IS_TESTNET !== 'false';
        const apiKey = `pp_${isTestnet ? 'test' : 'live'}_${rawHex}`;
        const hash = this.hashKey(apiKey);

        const metadata: ApiKeyMetadata = {
            hash,
            ownerAddress: address,
            label,
            createdAt: Date.now(),
            permissions,
            rateLimit,
            active: true,
        };

        // Store key metadata
        await this.kvStore.put(
            `${this.prefix}${hash}`,
            Buffer.from(JSON.stringify(metadata)),
        );

        // Update owner's key index
        await this.addToOwnerIndex(address, hash);

        return { apiKey, hash, metadata };
    }

    /**
     * Validate an API key and return its metadata.
     * Returns null if the key is invalid or revoked.
     *
     * @param rawKey The raw API key (pp_live_... or pp_test_...)
     */
    async validateKey(rawKey: string): Promise<{
        valid: boolean;
        ownerAddress?: string;
        permissions?: ApiKeyPermission[];
        hash?: string;
    }> {
        if (!rawKey.startsWith('pp_')) {
            return { valid: false };
        }

        const hash = this.hashKey(rawKey);
        const data = await this.kvStore.get(`${this.prefix}${hash}`);

        if (!data) {
            return { valid: false };
        }

        const metadata: ApiKeyMetadata = JSON.parse(data.toString());

        if (!metadata.active) {
            return { valid: false };
        }

        return {
            valid: true,
            ownerAddress: metadata.ownerAddress,
            permissions: metadata.permissions,
            hash,
        };
    }

    /**
     * Revoke an API key. The key immediately stops working.
     *
     * @param hash SHA-256 hash of the key
     * @param ownerAddress Must match the key's owner
     */
    async revokeKey(hash: string, ownerAddress: string): Promise<boolean> {
        const metadata = await this.getKeyMetadata(hash);
        if (!metadata || metadata.ownerAddress !== ownerAddress.toLowerCase()) {
            return false;
        }

        metadata.active = false;
        await this.kvStore.put(
            `${this.prefix}${hash}`,
            Buffer.from(JSON.stringify(metadata)),
        );

        // Remove from owner index
        await this.removeFromOwnerIndex(ownerAddress.toLowerCase(), hash);

        return true;
    }

    /**
     * Rotate a key: revoke the old one and generate a new one with the same label/permissions.
     *
     * @param hash SHA-256 hash of the key to rotate
     * @param ownerAddress Must match the key's owner
     * @returns New key details, or null if the old key wasn't found
     */
    async rotateKey(hash: string, ownerAddress: string): Promise<GenerateKeyResult | null> {
        const oldMetadata = await this.getKeyMetadata(hash);
        if (!oldMetadata || oldMetadata.ownerAddress !== ownerAddress.toLowerCase()) {
            return null;
        }

        // Revoke old key
        await this.revokeKey(hash, ownerAddress);

        // Generate new key with same label and permissions
        return this.generateKey(
            ownerAddress,
            oldMetadata.label,
            oldMetadata.permissions,
            oldMetadata.rateLimit,
        );
    }

    /**
     * List all API keys for a wallet address.
     * Returns metadata only (not the raw keys — those are never stored).
     */
    async listKeys(ownerAddress: string): Promise<ApiKeyMetadata[]> {
        const address = ownerAddress.toLowerCase();
        const indexData = await this.kvStore.get(`meta:apikeys-by-owner:${address}`);

        if (!indexData) return [];

        const hashes: string[] = JSON.parse(indexData.toString());
        const keys: ApiKeyMetadata[] = [];

        for (const hash of hashes) {
            const metadata = await this.getKeyMetadata(hash);
            if (metadata && metadata.active) {
                keys.push(metadata);
            }
        }

        return keys;
    }

    /**
     * Update permissions for a key.
     */
    async updatePermissions(
        hash: string,
        ownerAddress: string,
        permissions: ApiKeyPermission[],
    ): Promise<boolean> {
        const metadata = await this.getKeyMetadata(hash);
        if (!metadata || metadata.ownerAddress !== ownerAddress.toLowerCase()) {
            return false;
        }

        metadata.permissions = permissions;
        await this.kvStore.put(
            `${this.prefix}${hash}`,
            Buffer.from(JSON.stringify(metadata)),
        );

        return true;
    }

    /**
     * Get metadata for a specific key hash.
     */
    async getKeyMetadata(hash: string): Promise<ApiKeyMetadata | null> {
        const data = await this.kvStore.get(`${this.prefix}${hash}`);
        if (!data) return null;
        return JSON.parse(data.toString());
    }

    // ---- Internal Helpers ----

    /** Hash a raw API key with SHA-256 */
    private hashKey(rawKey: string): string {
        return createHash('sha256').update(rawKey).digest('hex');
    }

    /** Add a key hash to the owner's index */
    private async addToOwnerIndex(address: string, hash: string): Promise<void> {
        const indexKey = `meta:apikeys-by-owner:${address}`;
        const existing = await this.kvStore.get(indexKey);
        const hashes: string[] = existing ? JSON.parse(existing.toString()) : [];

        if (!hashes.includes(hash)) {
            hashes.push(hash);
            await this.kvStore.put(indexKey, Buffer.from(JSON.stringify(hashes)));
        }
    }

    /** Remove a key hash from the owner's index */
    private async removeFromOwnerIndex(address: string, hash: string): Promise<void> {
        const indexKey = `meta:apikeys-by-owner:${address}`;
        const existing = await this.kvStore.get(indexKey);
        if (!existing) return;

        const hashes: string[] = JSON.parse(existing.toString());
        const filtered = hashes.filter(h => h !== hash);
        await this.kvStore.put(indexKey, Buffer.from(JSON.stringify(filtered)));
    }
}
