// PlugPort Encryption Layer
// Client-side AES-256-GCM encryption/decryption that wraps any KVAdapter.
// OPTIONAL: Only active when STORAGE_MODE=private.
//
// Security properties:
//   - All data encrypted before reaching the contract (contract never sees plaintext)
//   - AES-256-GCM provides authenticated encryption (tamper detection)
//   - Encryption key derived from owner's private key via HKDF
//   - Key sharing with whitelisted addresses via ECDH key exchange
//   - Wire format: [12-byte IV] [16-byte auth tag] [N-byte ciphertext]
//
// Compatible with ALL protocols: MongoDB, PostgreSQL, MySQL, Redis, SQLite, HTTP.
// The encryption layer sits below DocumentStore, so all protocol frontends
// automatically get encryption without any code changes.

import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
    createHmac,
    createECDH,
    createHash,
} from 'crypto';
import type { KVAdapter, KVEntry, ScanOptions } from '@plugport/shared';

// ---- Types ----

export interface EncryptionConfig {
    /** Owner's private key (hex string, no 0x prefix). Used to derive AES key. */
    privateKey: string;
    /** Enable encryption globally. If false, acts as a passthrough (unless per-collection overrides). */
    enabled: boolean;
}

/** Per-collection encryption override */
interface CollectionEncryptionConfig {
    enabled: boolean;
    key?: Buffer; // Optional per-collection AES key (defaults to global key)
}

// ---- Key Derivation ----

/**
 * Derive a 256-bit AES key from the owner's Ethereum private key using HKDF.
 * Uses HMAC-SHA256 with a PlugPort-specific salt.
 */
function deriveAESKey(privateKey: string): Buffer {
    const keyBytes = Buffer.from(privateKey.replace(/^0x/, ''), 'hex');
    const salt = Buffer.from('plugport-private-store-v1', 'utf-8');

    // HKDF-Extract: PRK = HMAC-SHA256(salt, IKM)
    const prk = createHmac('sha256', salt).update(keyBytes).digest();

    // HKDF-Expand: OKM = HMAC-SHA256(PRK, info || 0x01) — one block is enough for 256 bits
    const info = Buffer.from('aes-256-gcm-encryption-key', 'utf-8');
    const okm = createHmac('sha256', prk)
        .update(Buffer.concat([info, Buffer.from([0x01])]))
        .digest();

    return okm; // 32 bytes = 256 bits
}

/**
 * Encrypt an AES key for a specific recipient using ECDH.
 * The recipient can decrypt with their private key.
 *
 * @param aesKey The 32-byte AES key to share
 * @param recipientPublicKey The recipient's secp256k1 public key (hex, uncompressed)
 * @param senderPrivateKey The sender's (owner's) private key (hex)
 * @returns Encrypted key share (can be stored on-chain via setKeyShare())
 */
export function encryptKeyForRecipient(
    aesKey: Buffer,
    recipientPublicKey: string,
    senderPrivateKey: string,
): Buffer {
    // Derive shared secret via ECDH
    const ecdh = createECDH('secp256k1');
    ecdh.setPrivateKey(Buffer.from(senderPrivateKey.replace(/^0x/, ''), 'hex'));

    const sharedSecret = ecdh.computeSecret(
        Buffer.from(recipientPublicKey.replace(/^0x/, ''), 'hex'),
    );

    // Derive encryption key from shared secret
    const encryptionKey = createHash('sha256').update(sharedSecret).digest();

    // Encrypt AES key with the derived encryption key
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(aesKey), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Format: [iv (12)] [tag (16)] [encrypted AES key (32)]
    return Buffer.concat([iv, tag, encrypted]);
}

/**
 * Decrypt an AES key share received from the owner.
 *
 * @param encryptedShare The encrypted key share from the contract
 * @param senderPublicKey The owner's secp256k1 public key (hex)
 * @param recipientPrivateKey The recipient's private key (hex)
 * @returns The 32-byte AES key
 */
export function decryptKeyShare(
    encryptedShare: Buffer,
    senderPublicKey: string,
    recipientPrivateKey: string,
): Buffer {
    // Derive shared secret via ECDH (same as sender)
    const ecdh = createECDH('secp256k1');
    ecdh.setPrivateKey(Buffer.from(recipientPrivateKey.replace(/^0x/, ''), 'hex'));

    const sharedSecret = ecdh.computeSecret(
        Buffer.from(senderPublicKey.replace(/^0x/, ''), 'hex'),
    );

    const encryptionKey = createHash('sha256').update(sharedSecret).digest();

    // Extract IV, auth tag, and ciphertext
    const iv = encryptedShare.subarray(0, 12);
    const tag = encryptedShare.subarray(12, 28);
    const ciphertext = encryptedShare.subarray(28);

    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ---- Encryption Layer (KVAdapter Wrapper) ----

/**
 * Transparent encryption layer that wraps any KVAdapter.
 * When enabled, encrypts values on put() and decrypts on get().
 * Compatible with all protocol frontends.
 */
export class EncryptionLayer implements KVAdapter {
    private aesKey: Buffer;
    private innerAdapter: KVAdapter;
    private enabled: boolean;
    private collectionConfig: Map<string, CollectionEncryptionConfig> = new Map();

    constructor(innerAdapter: KVAdapter, config: EncryptionConfig) {
        this.innerAdapter = innerAdapter;
        this.enabled = config.enabled;

        if (config.enabled) {
            this.aesKey = deriveAESKey(config.privateKey);
        } else {
            this.aesKey = Buffer.alloc(32); // unused
        }
    }

    /**
     * Get the raw AES key (for key sharing with whitelisted addresses).
     */
    getAESKey(): Buffer {
        return Buffer.from(this.aesKey);
    }

    /**
     * Set per-collection encryption override.
     * When set, this overrides the global `enabled` flag for keys in that collection.
     * @param collectionName The collection name
     * @param enabled Whether encryption is enabled for this collection
     * @param key Optional per-collection AES key (defaults to global key)
     */
    setCollectionEncryption(collectionName: string, enabled: boolean, key?: Buffer): void {
        this.collectionConfig.set(collectionName, { enabled, key });
    }

    /**
     * Remove per-collection encryption override (falls back to global setting).
     */
    removeCollectionEncryption(collectionName: string): void {
        this.collectionConfig.delete(collectionName);
    }

    /**
     * Check if a collection is encrypted (considering per-collection overrides).
     */
    isCollectionEncrypted(collectionName: string): boolean {
        const config = this.collectionConfig.get(collectionName);
        if (config) return config.enabled;
        return this.enabled;
    }

    /**
     * Extract collection name from a key.
     * PlugPort keys follow the format: `col:<collectionName>:doc:<id>` or `col:<collectionName>:idx:<name>`
     * Falls back to null if the key doesn't match collection patterns.
     */
    private extractCollection(key: string): string | null {
        if (key.startsWith('col:')) {
            const parts = key.split(':');
            return parts[1] || null;
        }
        return null;
    }

    /**
     * Get the effective AES key for a given KV key (considers per-collection config).
     */
    private getKeyForEntry(key: string): Buffer {
        const collection = this.extractCollection(key);
        if (collection) {
            const config = this.collectionConfig.get(collection);
            if (config?.key) return config.key;
        }
        return this.aesKey;
    }

    /**
     * Check if encryption is active for a given KV key.
     */
    private isEncryptionActive(key: string): boolean {
        const collection = this.extractCollection(key);
        if (collection) {
            const config = this.collectionConfig.get(collection);
            if (config) return config.enabled;
        }
        // Metadata keys (meta:*, analytics:*) are never encrypted
        if (key.startsWith('meta:') || key.startsWith('analytics:')) return false;
        return this.enabled;
    }

    // ---- KVAdapter Implementation ----

    async get(key: string): Promise<Buffer | null> {
        const encrypted = await this.innerAdapter.get(key);
        if (!encrypted) return null;
        if (!this.isEncryptionActive(key)) return encrypted;

        try {
            return this.decrypt(encrypted, this.getKeyForEntry(key));
        } catch {
            // If decryption fails, return raw (might be unencrypted legacy data)
            return encrypted;
        }
    }

    async put(key: string, value: Buffer | Uint8Array): Promise<void> {
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (!this.isEncryptionActive(key)) {
            return this.innerAdapter.put(key, buf);
        }

        const encrypted = this.encrypt(buf, this.getKeyForEntry(key));
        return this.innerAdapter.put(key, encrypted);
    }

    async delete(key: string): Promise<boolean> {
        return this.innerAdapter.delete(key);
    }

    async scan(options: ScanOptions): Promise<KVEntry[]> {
        const entries = await this.innerAdapter.scan(options);

        // Decrypt each value based on per-key encryption status
        return entries.map(entry => {
            if (!this.isEncryptionActive(entry.key)) return entry;
            try {
                return {
                    key: entry.key,
                    value: this.decrypt(Buffer.from(entry.value), this.getKeyForEntry(entry.key)),
                };
            } catch {
                return entry; // Return raw if decryption fails
            }
        });
    }

    async has(key: string): Promise<boolean> {
        return this.innerAdapter.has(key);
    }

    async count(prefix?: string): Promise<number> {
        return this.innerAdapter.count(prefix);
    }

    async clear(): Promise<void> {
        return this.innerAdapter.clear();
    }

    async batchWrite(
        puts: { key: string; value: Buffer | Uint8Array }[],
        deletes: string[],
    ): Promise<void> {
        // Encrypt values based on per-key encryption status
        const processedPuts = puts.map(({ key, value }) => {
            const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
            if (!this.isEncryptionActive(key)) return { key, value: buf };
            return {
                key,
                value: this.encrypt(buf, this.getKeyForEntry(key)),
            };
        });

        if (this.innerAdapter.batchWrite) {
            return this.innerAdapter.batchWrite(processedPuts, deletes);
        }

        for (const { key, value } of processedPuts) {
            await this.innerAdapter.put(key, value);
        }
        for (const key of deletes) {
            await this.innerAdapter.delete(key);
        }
    }

    // ---- Encryption / Decryption ----

    /**
     * Encrypt plaintext with AES-256-GCM.
     * Output format: [12-byte IV] [16-byte auth tag] [N-byte ciphertext]
     */
    private encrypt(plaintext: Buffer, aesKey?: Buffer): Buffer {
        const key = aesKey || this.aesKey;
        const iv = randomBytes(12); // 96-bit IV for GCM
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag(); // 16-byte authentication tag

        return Buffer.concat([iv, tag, encrypted]);
    }

    /**
     * Decrypt ciphertext with AES-256-GCM.
     * Input format: [12-byte IV] [16-byte auth tag] [N-byte ciphertext]
     */
    private decrypt(data: Buffer, aesKey?: Buffer): Buffer {
        if (data.length < 28) {
            throw new Error('EncryptionLayer: data too short for AES-256-GCM');
        }

        const key = aesKey || this.aesKey;
        const iv = data.subarray(0, 12);
        const tag = data.subarray(12, 28);
        const ciphertext = data.subarray(28);

        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);

        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }
}
