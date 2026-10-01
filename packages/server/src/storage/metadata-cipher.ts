// Hiding private collections' metadata on the public contract (P9).
//
// A private collection's documents are encrypted, but its metadata used to sit
// in the public store in the clear: the collection record (name, document
// count, index field names) and the privacy record (owner, the store holding
// it, and every wallet granted access). The public contract's key log is
// plaintext too, so even the collection's name was readable on chain.
//
// For private collections both records are now stored under a *blinded* key —
// an HMAC of the collection name, so the name doesn't appear — with the value
// encrypted (AES-256-GCM). Anyone reading the chain sees only that some
// encrypted record exists. The server, holding ENCRYPTION_KEY, can still
// decrypt every record, which is how listings, "My Collections" and routing
// keep working. The records stay in the public store rather than in the
// customer's own store: routing needs the privacy record to find that store.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export interface MetadataCipher {
    /** Opaque, stable stand-in for a collection name in storage keys. */
    blind(collection: string): string;
    seal(plain: Buffer): Buffer;
    /** Throws if the data was not sealed with this key or was altered. */
    open(sealed: Buffer): Buffer;
}

const MAGIC = Buffer.from('PPM1');

export function createMetadataCipher(rootKey: string): MetadataCipher {
    const root = Buffer.from(rootKey.replace(/^0x/, ''), 'hex');
    const blindKey = createHmac('sha256', root).update('plugport-metadata-blind-v1').digest();
    const sealKey = createHmac('sha256', root).update('plugport-metadata-seal-v1').digest();
    return {
        blind: (collection) => createHmac('sha256', blindKey).update(collection).digest('hex').slice(0, 32),
        seal(plain) {
            const iv = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', sealKey, iv);
            const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
            return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
        },
        open(sealed) {
            if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not sealed metadata');
            const body = sealed.subarray(MAGIC.length);
            const decipher = createDecipheriv('aes-256-gcm', sealKey, body.subarray(0, 12));
            decipher.setAuthTag(body.subarray(12, 28));
            return Buffer.concat([decipher.update(body.subarray(28)), decipher.final()]);
        },
    };
}
