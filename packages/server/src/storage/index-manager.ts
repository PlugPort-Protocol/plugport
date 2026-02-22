// PlugPort Index Manager
// Handles index CRUD, maintenance on document writes, and unique constraint enforcement

import type { KVAdapter, IndexDefinition, CollectionMetadata } from '@plugport/shared';
import { ErrorCodes } from '@plugport/shared';
import {
    encodeIdxKey,
    decodeIdxKey,
    idxPrefix,
    idxCollectionPrefix,
    encodeValue,
    encodeMetaKey,
} from './key-encoding.js';

export class IndexError extends Error {
    constructor(
        public code: number,
        message: string,
    ) {
        super(message);
        this.name = 'IndexError';
    }
}

export class IndexManager {
    constructor(private kv: KVAdapter) { }

    /**
     * Create an index on a collection field.
     * If the collection already has documents, builds the index retroactively.
     */
    async createIndex(
        metadata: CollectionMetadata,
        field: string,
        unique: boolean = false,
    ): Promise<IndexDefinition> {
        // Check if index already exists
        const existing = metadata.indexes.find((idx) => idx.field === field);
        if (existing) {
            return existing;
        }

        const indexName = `${field}_1`;
        const indexDef: IndexDefinition = { name: indexName, field, unique };
        const collectionName = metadata.name;

        // Build index for existing documents using streaming chunks to prevent OOM
        const seen = unique ? new Map<string, string>() : null;
        let lastKey: string | undefined = undefined;
        const BATCH_LIMIT = 5000;
        const prefix = `doc:${collectionName}:`;

        while (true) {
            const entries = await this.kv.scan({
                prefix: prefix,
                startKey: lastKey ? lastKey + '\x00' : undefined,
                limit: BATCH_LIMIT
            });

            if (entries.length === 0) break;

            for (const entry of entries) {
                lastKey = entry.key;
                const doc = JSON.parse(entry.value.toString()) as Record<string, unknown> & { _id: string };
                const value = doc[field];

                if (value !== undefined && value !== null) {
                    if (unique && seen) {
                        const encoded = encodeValue(value);
                        if (seen.has(encoded)) {
                            throw new IndexError(
                                ErrorCodes.DuplicateKey,
                                `E11000 duplicate key error: index ${indexName} dup key for field "${field}"`,
                            );
                        }
                        seen.set(encoded, doc._id);
                    }

                    // Write index entry
                    const key = encodeIdxKey(collectionName, field, value, doc._id);
                    await this.kv.put(key, Buffer.from('1'));
                }
            }

            if (entries.length < BATCH_LIMIT) break;
        }

        return indexDef;
    }

    /**
     * Drop an index from a collection.
     */
    async dropIndex(collectionName: string, field: string): Promise<void> {
        // Remove all index entries for this field in chunks
        const BATCH_LIMIT = 5000;
        const prefix = idxPrefix(collectionName, field);
        let lastKey: string | undefined = undefined;

        while (true) {
            const entries = await this.kv.scan({
                prefix,
                startKey: lastKey ? lastKey + '\x00' : undefined,
                limit: BATCH_LIMIT
            });

            if (entries.length === 0) break;

            for (const entry of entries) {
                lastKey = entry.key;
                await this.kv.delete(entry.key);
            }

            if (entries.length < BATCH_LIMIT) break;
        }
    }

    /**
     * Maintain indexes on document insert.
     */
    async onInsert(
        collectionName: string,
        indexes: IndexDefinition[],
        doc: Record<string, unknown>,
        docId: string,
    ): Promise<void> {
        const puts: { key: string; value: Buffer }[] = [];

        // Phase 1: Pre-flight checks and build operations array
        for (const index of indexes) {
            const value = doc[index.field];
            if (value === undefined || value === null) continue;

            if (index.unique) {
                await this.checkUnique(collectionName, index, value, docId, false);
            }

            const key = encodeIdxKey(collectionName, index.field, value, docId);
            puts.push({ key, value: Buffer.from('1') });
        }

        // Phase 2: Execute mutations atomically
        for (const put of puts) {
            await this.kv.put(put.key, put.value);
        }
    }

    /**
     * Maintain indexes on document update.
     */
    async onUpdate(
        collectionName: string,
        indexes: IndexDefinition[],
        oldDoc: Record<string, unknown>,
        newDoc: Record<string, unknown>,
        docId: string,
    ): Promise<void> {
        const deletes: string[] = [];
        const puts: { key: string; value: Buffer }[] = [];

        // Phase 1: Pre-flight checks and build operations arrays
        for (const index of indexes) {
            const oldValue = oldDoc[index.field];
            const newValue = newDoc[index.field];

            // Skip if value unchanged
            if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;

            if (oldValue !== undefined && oldValue !== null) {
                deletes.push(encodeIdxKey(collectionName, index.field, oldValue, docId));
            }

            if (newValue !== undefined && newValue !== null) {
                if (index.unique) {
                    await this.checkUnique(collectionName, index, newValue, docId, true);
                }
                puts.push({
                    key: encodeIdxKey(collectionName, index.field, newValue, docId),
                    value: Buffer.from('1')
                });
            }
        }

        // Phase 2: Execute mutations automatically
        for (const key of deletes) {
            await this.kv.delete(key);
        }
        for (const put of puts) {
            await this.kv.put(put.key, put.value);
        }
    }

    /**
     * Maintain indexes on document delete.
     */
    async onDelete(
        collectionName: string,
        indexes: IndexDefinition[],
        doc: Record<string, unknown>,
        docId: string,
    ): Promise<void> {
        for (const index of indexes) {
            const value = doc[index.field];
            if (value === undefined || value === null) continue;
            const key = encodeIdxKey(collectionName, index.field, value, docId);
            await this.kv.delete(key);
        }
    }

    /**
     * Remove all index entries for a collection.
     */
    async dropAllIndexes(collectionName: string): Promise<void> {
        const BATCH_LIMIT = 5000;
        const prefix = idxCollectionPrefix(collectionName);
        let lastKey: string | undefined = undefined;

        while (true) {
            const entries = await this.kv.scan({
                prefix,
                startKey: lastKey ? lastKey + '\x00' : undefined,
                limit: BATCH_LIMIT
            });

            if (entries.length === 0) break;

            for (const entry of entries) {
                lastKey = entry.key;
                await this.kv.delete(entry.key);
            }

            if (entries.length < BATCH_LIMIT) break;
        }
    }

    /**
     * Check unique constraint for an index.
     */
    private async checkUnique(
        collectionName: string,
        index: IndexDefinition,
        value: unknown,
        currentDocId: string,
        excludeSelf: boolean = false,
    ): Promise<void> {
        const encoded = encodeValue(value);
        const prefix = `${idxPrefix(collectionName, index.field)}${encoded}\x1F`;
        const existing = await this.kv.scan({ prefix, limit: 2 });

        for (const entry of existing) {
            // On update, skip the current document's own index entry (self-collision)
            if (excludeSelf) {
                const decoded = decodeIdxKey(entry.key);
                if (decoded && decoded.id === currentDocId) continue;
            }

            throw new IndexError(
                ErrorCodes.DuplicateKey,
                `E11000 duplicate key error collection: ${collectionName} index: ${index.name} dup key: { ${index.field}: ${JSON.stringify(value)} }`,
            );
        }
    }

    /**
     * Scan an index for matching entries.
     * Returns document IDs matching the scan criteria.
     */
    async scanIndex(
        collectionName: string,
        field: string,
        startKey?: string,
        endKey?: string,
        limit?: number,
    ): Promise<string[]> {
        const prefix = idxPrefix(collectionName, field);
        const entries = await this.kv.scan({
            prefix,
            startKey: startKey || prefix,
            endKey: endKey || `${prefix}\xff`,
            limit,
        });

        return entries.map((entry) => {
            const decoded = decodeIdxKey(entry.key);
            return decoded ? decoded.id : '';
        }).filter(Boolean);
    }
}
