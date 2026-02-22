// PlugPort Document Store
// Main storage coordinator: manages collections, documents, indexes, and metadata.
// Bridges the command layer to the KV adapter through the index manager and query planner.

import { v4 as uuidv4 } from 'uuid';
import type {
    KVAdapter,
    Document,
    DocumentWithId,
    Filter,
    Projection,
    SortSpec,
    CollectionMetadata,
    IndexDefinition,
    InsertResult,
    FindResult,
    UpdateResult,
    DeleteResult,
    CreateIndexResult,
} from '@plugport/shared';
import { ErrorCodes } from '@plugport/shared';
import { encodeDocKey, encodeMetaKey, docPrefix, metaPrefix } from './key-encoding.js';
import { IndexManager, IndexError } from './index-manager.js';
import { planQuery, executeQuery, matchesFilter } from './query-planner.js';

// ---- Constants ----

/** Default limit for unbounded queries to prevent OOM */
const DEFAULT_QUERY_LIMIT = 1000;

/** Absolute maximum explicit queries ceiling */
const MAX_QUERY_LIMIT = 5000;

/** Maximum allowed collection name length */
const MAX_COLLECTION_NAME_LENGTH = 120;

/** Forbidden patterns in collection names */
const COLLECTION_NAME_BLOCKLIST = /[:\/\\\x00]|^\s*$|\.\.|\.\.|^system\./;

/** Forbidden keys in document bodies (prototype pollution prevention) */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---- Validation Helpers ----

/**
 * Validate a collection name.
 * Rejects names with dangerous characters, empty strings, or excessive length.
 */
export function validateCollectionName(name: unknown): asserts name is string {
    if (typeof name !== 'string' || name.length === 0) {
        throw new DocumentStoreError(
            ErrorCodes.InvalidNamespace,
            'Collection name must be a non-empty string',
            'InvalidNamespace',
        );
    }
    if (name.length > MAX_COLLECTION_NAME_LENGTH) {
        throw new DocumentStoreError(
            ErrorCodes.InvalidNamespace,
            `Collection name exceeds maximum length of ${MAX_COLLECTION_NAME_LENGTH} characters`,
            'InvalidNamespace',
        );
    }
    if (COLLECTION_NAME_BLOCKLIST.test(name)) {
        throw new DocumentStoreError(
            ErrorCodes.InvalidNamespace,
            `Invalid collection name "${name}": must not contain ':', '/', '\\', null bytes, '..' or start with 'system.'`,
            'InvalidNamespace',
        );
    }
}

/**
 * Recursively check for prototype-pollution keys in a document.
 * Rejects documents containing __proto__, constructor, or prototype keys.
 */
export function sanitizeDocument(doc: Record<string, unknown>, depth = 0): void {
    if (depth > 20) {
        throw new DocumentStoreError(
            ErrorCodes.DocumentTooLarge,
            'Document nesting exceeds maximum depth of 20',
        );
    }
    for (const key of Object.keys(doc)) {
        if (DANGEROUS_KEYS.has(key)) {
            throw new DocumentStoreError(
                ErrorCodes.BadValue,
                `Document contains forbidden key "${key}"`,
                'BadValue',
            );
        }
        const val = doc[key];
        if (val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
            sanitizeDocument(val as Record<string, unknown>, depth + 1);
        } else if (Array.isArray(val)) {
            for (const item of val) {
                if (item !== null && typeof item === 'object' && !(item instanceof Date)) {
                    sanitizeDocument(item as Record<string, unknown>, depth + 1);
                }
            }
        }
    }
}

/**
 * Strip $-operator keys from a filter, returning only plain equality values.
 * Used for upsert base documents so operators don't leak into stored data.
 */
function stripOperators(filter: Filter): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filter)) {
        if (key.startsWith('$')) continue; // skip top-level operators
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            // Check if it's an operator object like { $gte: 25 }
            const keys = Object.keys(value as object);
            if (keys.some(k => k.startsWith('$'))) continue; // skip operator fields
        }
        result[key] = value;
    }
    return result;
}

export class DocumentStoreError extends Error {
    constructor(
        public code: number,
        message: string,
        public codeName?: string,
    ) {
        super(message);
        this.name = 'DocumentStoreError';
    }
}

/**
 * Lightweight asynchronous Mutex to enforce sequential execution per-collection
 * Preventing metadata race condition overwrites on concurrent requests.
 */
class Mutex {
    private mutex = Promise.resolve();

    lock(): Promise<() => void> {
        let begin: (unlock: () => void) => void;
        this.mutex = this.mutex.then(() => {
            return new Promise(begin);
        });

        return new Promise((res) => {
            begin = res;
        });
    }
}

export class DocumentStore {
    private indexManager: IndexManager;
    private collectionLocks: Record<string, Mutex> = {};

    constructor(
        private kv: KVAdapter,
        private maxDocumentSize: number = 1024 * 1024,
    ) {
        this.indexManager = new IndexManager(kv);
    }

    private getCollectionLock(collection: string): Mutex {
        if (!this.collectionLocks[collection]) {
            this.collectionLocks[collection] = new Mutex();
        }
        return this.collectionLocks[collection];
    }

    // ---- Collection Management ----

    /**
     * Get or create collection metadata.
     * Auto-creates collection with _id index if it doesn't exist.
     */
    async getOrCreateCollection(name: string): Promise<CollectionMetadata> {
        validateCollectionName(name);
        const metaKey = encodeMetaKey(name);
        const existing = await this.kv.get(metaKey);

        if (existing) {
            return JSON.parse(existing.toString());
        }

        // Auto-create collection
        const metadata: CollectionMetadata = {
            name,
            indexes: [{ name: '_id_', field: '_id', unique: true }],
            options: {
                createdAt: Date.now(),
                schemaVersion: 1,
            },
            documentCount: 0,
        };

        await this.kv.put(metaKey, Buffer.from(JSON.stringify(metadata)));
        return metadata;
    }

    /**
     * Get collection metadata. Returns null if collection doesn't exist.
     */
    async getCollection(name: string): Promise<CollectionMetadata | null> {
        const metaKey = encodeMetaKey(name);
        const data = await this.kv.get(metaKey);
        return data ? JSON.parse(data.toString()) : null;
    }

    /**
     * List all collections.
     */
    async listCollections(): Promise<CollectionMetadata[]> {
        const prefix = metaPrefix();
        const entries = await this.kv.scan({ prefix, limit: 1000 });
        return entries.map((e) => JSON.parse(e.value.toString()));
    }

    /**
     * Drop a collection and all its data.
     */
    async dropCollection(name: string): Promise<boolean> {
        const metadata = await this.getCollection(name);
        if (!metadata) return false;

        // Delete all documents in chunks to prevent OOM
        const BATCH_LIMIT = 5000;
        const prefix = docPrefix(name);
        let lastKey: string | undefined = undefined;

        while (true) {
            const docEntries = await this.kv.scan({
                prefix,
                startKey: lastKey ? lastKey + '\x00' : undefined,
                limit: BATCH_LIMIT
            });

            if (docEntries.length === 0) break;

            for (const entry of docEntries) {
                lastKey = entry.key;
                await this.kv.delete(entry.key);
            }

            if (docEntries.length < BATCH_LIMIT) break;
        }

        // Delete all index entries
        await this.indexManager.dropAllIndexes(name);

        // Delete metadata
        await this.kv.delete(encodeMetaKey(name));

        return true;
    }

    /**
     * Save updated collection metadata.
     */
    private async saveMetadata(metadata: CollectionMetadata): Promise<void> {
        const metaKey = encodeMetaKey(metadata.name);
        await this.kv.put(metaKey, Buffer.from(JSON.stringify(metadata)));
    }

    // ---- CRUD Operations ----

    /**
     * Insert one or more documents into a collection.
     */
    async insert(collection: string, documents: Document[]): Promise<InsertResult> {
        validateCollectionName(collection);

        // Validate all documents upfront before any writes
        for (const doc of documents) {
            sanitizeDocument(doc as Record<string, unknown>);
        }

        const unlock = await this.getCollectionLock(collection).lock();
        try {
            return await this._insertInternal(collection, documents);
        } finally {
            unlock();
        }
    }

    /**
     * Internal unsafe insertion logic executed inside pre-locked boundaries.
     */
    private async _insertInternal(collection: string, documents: Document[]): Promise<InsertResult> {
        const metadata = await this.getOrCreateCollection(collection);
        const insertedIds: string[] = [];
        const BATCH_LIMIT = 5000;

        for (let i = 0; i < documents.length; i += BATCH_LIMIT) {
            const chunk = documents.slice(i, i + BATCH_LIMIT);
            const puts: { key: string; value: Buffer }[] = [];
            const chunkInsertedIds: string[] = [];

            for (const doc of chunk) {
                // Generate _id if not present
                const docWithId: DocumentWithId = {
                    ...doc,
                    _id: doc._id || this.generateId(),
                };

                // Validate document size
                const serialized = JSON.stringify(docWithId);
                if (serialized.length > this.maxDocumentSize) {
                    // Update count for already-inserted docs before throwing
                    if (insertedIds.length > 0) {
                        metadata.documentCount += insertedIds.length;
                        await this.saveMetadata(metadata);
                    }
                    throw new DocumentStoreError(
                        ErrorCodes.DocumentTooLarge,
                        `Document exceeds maximum size of ${this.maxDocumentSize} bytes`,
                    );
                }

                // Maintain indexes (will throw on unique violation)
                try {
                    await this.indexManager.onInsert(
                        collection,
                        metadata.indexes,
                        docWithId,
                        docWithId._id,
                    );
                } catch (err) {
                    // Update count for already-inserted docs before throwing
                    if (insertedIds.length > 0) {
                        metadata.documentCount += insertedIds.length;
                        await this.saveMetadata(metadata);
                    }
                    if (err instanceof IndexError) {
                        throw new DocumentStoreError(err.code, err.message);
                    }
                    throw err;
                }

                // Store document
                const docKey = encodeDocKey(collection, docWithId._id);
                if (this.kv.batchWrite) {
                    puts.push({ key: docKey, value: Buffer.from(serialized) });
                } else {
                    await this.kv.put(docKey, Buffer.from(serialized));
                }
                chunkInsertedIds.push(docWithId._id);
            }

            // Send batched puts to the adapter
            if (this.kv.batchWrite && puts.length > 0) {
                try {
                    await this.kv.batchWrite(puts, []);
                } catch (err) {
                    // If the batch fails at the very end we must roll back the index manager additions.
                    // In production, proper ACID transactions apply here.
                    for (const docWithId of chunk as DocumentWithId[]) {
                        if (!chunkInsertedIds.includes(docWithId._id)) continue;

                        await this.indexManager.onDelete(
                            collection,
                            metadata.indexes,
                            docWithId,
                            docWithId._id
                        ).catch(() => { });
                    }
                    throw err;
                }
            }

            // Add successful chunks
            insertedIds.push(...chunkInsertedIds);
        }

        // Update document count with actual inserted count
        metadata.documentCount += insertedIds.length;
        await this.saveMetadata(metadata);

        return {
            acknowledged: true,
            insertedId: insertedIds.length === 1 ? insertedIds[0] : undefined,
            insertedIds: insertedIds.length > 1 ? insertedIds : undefined,
            insertedCount: insertedIds.length,
        };
    }

    /**
     * Find documents matching a filter.
     */
    async find(
        collection: string,
        filter: Filter = {},
        options: {
            projection?: Projection;
            sort?: SortSpec;
            limit?: number;
            skip?: number;
        } = {},
    ): Promise<FindResult> {
        validateCollectionName(collection);
        sanitizeDocument(filter as Record<string, unknown>);

        const metadata = await this.getCollection(collection);
        if (!metadata) {
            return {
                cursor: { firstBatch: [], id: 0 },
                ok: 1,
            };
        }

        // Apply default limit and absolute caps to prevent unbounded queries from loading all docs into memory
        const requestedLimit = options.limit && options.limit > 0 ? options.limit : DEFAULT_QUERY_LIMIT;
        const safeOptions = {
            ...options,
            limit: Math.min(requestedLimit, MAX_QUERY_LIMIT),
        };

        const plan = planQuery(filter, metadata.indexes, collection);
        const result = await executeQuery(this.kv, plan, collection, filter, safeOptions);

        return {
            cursor: {
                firstBatch: result.documents,
                id: 0, // No server-side cursors in MVP
            },
            ok: 1,
        };
    }

    /**
     * Update documents matching a filter.
     */
    async updateOne(
        collection: string,
        filter: Filter,
        update: { $set?: Record<string, unknown>; $inc?: Record<string, number>; $unset?: Record<string, unknown> },
        options: { upsert?: boolean } = {},
    ): Promise<UpdateResult> {
        validateCollectionName(collection);
        sanitizeDocument(filter as Record<string, unknown>);
        if (update.$set) {
            sanitizeDocument(update.$set);
        }
        if (update.$inc) {
            sanitizeDocument(update.$inc as Record<string, unknown>);
        }
        if (update.$unset) {
            sanitizeDocument(update.$unset as Record<string, unknown>);
        }

        const unlock = await this.getCollectionLock(collection).lock();
        try {
            const metadata = await this.getOrCreateCollection(collection);

            // Find the document to update
            const plan = planQuery(filter, metadata.indexes, collection);
            const result = await executeQuery(this.kv, plan, collection, filter, { limit: 1 });

            if (result.documents.length === 0) {
                if (options.upsert) {
                    // Upsert: strip $-operators from filter so they don't leak into stored data
                    const baseDoc: Document = stripOperators(filter);
                    if (update.$set) Object.assign(baseDoc, update.$set);
                    if (update.$inc) {
                        for (const [field, amount] of Object.entries(update.$inc)) {
                            (baseDoc as Record<string, unknown>)[field] = amount;
                        }
                    }
                    const insertResult = await this._insertInternal(collection, [baseDoc]);
                    return {
                        acknowledged: true,
                        matchedCount: 0,
                        modifiedCount: 0,
                        upsertedId: insertResult.insertedId || null,
                    };
                }
                return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
            }

            const doc = result.documents[0];
            const oldDoc = { ...doc };
            const newDoc = { ...doc };

            // Apply $set operator
            if (update.$set) {
                for (const [field, value] of Object.entries(update.$set)) {
                    (newDoc as Record<string, unknown>)[field] = value;
                }
            }

            // Apply $inc operator
            if (update.$inc) {
                for (const [field, amount] of Object.entries(update.$inc)) {
                    const current = (newDoc as Record<string, unknown>)[field];
                    const currentNum = typeof current === 'number' ? current : 0;
                    (newDoc as Record<string, unknown>)[field] = currentNum + amount;
                }
            }

            // Apply $unset operator
            if (update.$unset) {
                for (const field of Object.keys(update.$unset)) {
                    delete (newDoc as Record<string, unknown>)[field];
                }
            }

            // Update indexes
            try {
                await this.indexManager.onUpdate(
                    collection,
                    metadata.indexes,
                    oldDoc,
                    newDoc,
                    doc._id,
                );
            } catch (err) {
                if (err instanceof IndexError) {
                    throw new DocumentStoreError(err.code, err.message);
                }
                throw err;
            }

            // Store updated document
            const docKey = encodeDocKey(collection, doc._id);
            await this.kv.put(docKey, Buffer.from(JSON.stringify(newDoc)));

            return {
                acknowledged: true,
                matchedCount: 1,
                modifiedCount: 1,
                upsertedId: null,
            };
        } finally {
            unlock();
        }
    }

    /**
     * Update many documents matching a filter.
     */
    async updateMany(
        collection: string,
        filter: Filter,
        update: { $set?: Record<string, unknown>; $inc?: Record<string, number>; $unset?: Record<string, unknown> },
        options: { upsert?: boolean } = {},
    ): Promise<UpdateResult> {
        validateCollectionName(collection);
        sanitizeDocument(filter as Record<string, unknown>);
        if (update.$set) sanitizeDocument(update.$set);
        if (update.$inc) sanitizeDocument(update.$inc as Record<string, unknown>);
        if (update.$unset) sanitizeDocument(update.$unset as Record<string, unknown>);

        const unlock = await this.getCollectionLock(collection).lock();
        try {
            const metadata = await this.getCollection(collection);
            if (!metadata) {
                if (options.upsert) {
                    const baseDoc: Document = stripOperators(filter);
                    if (update.$set) Object.assign(baseDoc, update.$set);
                    if (update.$inc) {
                        for (const [field, amount] of Object.entries(update.$inc)) {
                            (baseDoc as Record<string, unknown>)[field] = amount;
                        }
                    }
                    const insertResult = await this._insertInternal(collection, [baseDoc]);
                    return {
                        acknowledged: true,
                        matchedCount: 0,
                        modifiedCount: 0,
                        upsertedId: insertResult.insertedId || null,
                    };
                }
                return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
            }

            const plan = planQuery(filter, metadata.indexes, collection);

            // Limit the maximum number of updated documents in a single sweep to 50,000
            // protecting the Free-Tier hosting RAM limit from overflowing.
            const MAX_BULK_UPDATE_LIMIT = 50000;
            const result = await executeQuery(this.kv, plan, collection, filter, { limit: MAX_BULK_UPDATE_LIMIT });

            let totalMatched = 0;
            let totalModified = 0;
            const BATCH_LIMIT = 5000;

            for (let i = 0; i < result.documents.length; i += BATCH_LIMIT) {
                const chunk = result.documents.slice(i, i + BATCH_LIMIT);
                const puts: { key: string; value: Buffer }[] = [];

                for (const doc of chunk) {
                    const oldDoc = { ...doc };
                    const newDoc = { ...doc };

                    let modified = false;
                    if (update.$set) {
                        for (const [field, value] of Object.entries(update.$set)) {
                            if ((newDoc as Record<string, unknown>)[field] !== value) {
                                (newDoc as Record<string, unknown>)[field] = value;
                                modified = true;
                            }
                        }
                    }

                    // Apply $inc operator
                    if (update.$inc) {
                        for (const [field, amount] of Object.entries(update.$inc)) {
                            const current = (newDoc as Record<string, unknown>)[field];
                            const currentNum = typeof current === 'number' ? current : 0;
                            (newDoc as Record<string, unknown>)[field] = currentNum + amount;
                            modified = true;
                        }
                    }

                    // Apply $unset operator
                    if (update.$unset) {
                        for (const field of Object.keys(update.$unset)) {
                            if (field in newDoc) {
                                delete (newDoc as Record<string, unknown>)[field];
                                modified = true;
                            }
                        }
                    }

                    if (modified) {
                        try {
                            await this.indexManager.onUpdate(collection, metadata.indexes, oldDoc, newDoc, doc._id);
                        } catch (err) {
                            if (err instanceof IndexError) {
                                throw new DocumentStoreError(err.code, err.message);
                            }
                            throw err;
                        }
                    }

                    const docKey = encodeDocKey(collection, doc._id);
                    if (this.kv.batchWrite) {
                        puts.push({ key: docKey, value: Buffer.from(JSON.stringify(newDoc)) });
                    } else {
                        await this.kv.put(docKey, Buffer.from(JSON.stringify(newDoc)));
                    }

                    totalMatched++;
                    if (modified) totalModified++;
                }

                if (this.kv.batchWrite && puts.length > 0) {
                    await this.kv.batchWrite(puts, []);
                }
            }

            return {
                acknowledged: true,
                matchedCount: totalMatched,
                modifiedCount: totalModified,
                upsertedId: null,
            };
        } finally {
            unlock();
        }
    }

    /**
     * Delete documents matching a filter.
     */
    async deleteOne(collection: string, filter: Filter): Promise<DeleteResult> {
        validateCollectionName(collection);
        sanitizeDocument(filter as Record<string, unknown>);

        const unlock = await this.getCollectionLock(collection).lock();
        try {
            const metadata = await this.getCollection(collection);
            if (!metadata) {
                return { acknowledged: true, deletedCount: 0 };
            }

            // Find the document to delete
            const plan = planQuery(filter, metadata.indexes, collection);
            const result = await executeQuery(this.kv, plan, collection, filter, { limit: 1 });

            if (result.documents.length === 0) {
                return { acknowledged: true, deletedCount: 0 };
            }

            const doc = result.documents[0];

            // Remove index entries
            await this.indexManager.onDelete(collection, metadata.indexes, doc, doc._id);

            // Remove document
            const docKey = encodeDocKey(collection, doc._id);
            await this.kv.delete(docKey);

            // Update document count
            metadata.documentCount = Math.max(0, metadata.documentCount - 1);
            await this.saveMetadata(metadata);

            return { acknowledged: true, deletedCount: 1 };
        } finally {
            unlock();
        }
    }

    /**
     * Delete many documents matching a filter.
     */
    async deleteMany(collection: string, filter: Filter): Promise<DeleteResult> {
        validateCollectionName(collection);
        sanitizeDocument(filter as Record<string, unknown>);

        const unlock = await this.getCollectionLock(collection).lock();
        try {
            const metadata = await this.getCollection(collection);
            if (!metadata) {
                return { acknowledged: true, deletedCount: 0 };
            }

            const BATCH_LIMIT = 5000;
            let totalDeleted = 0;

            while (true) {
                const plan = planQuery(filter, metadata.indexes, collection);
                const result = await executeQuery(this.kv, plan, collection, filter, { limit: BATCH_LIMIT });

                if (result.documents.length === 0) {
                    break;
                }

                const deletes: string[] = [];
                for (const doc of result.documents) {
                    await this.indexManager.onDelete(collection, metadata.indexes, doc, doc._id);
                    const docKey = encodeDocKey(collection, doc._id);
                    if (this.kv.batchWrite) {
                        deletes.push(docKey);
                    } else {
                        await this.kv.delete(docKey);
                    }
                    totalDeleted++;
                }

                if (this.kv.batchWrite && deletes.length > 0) {
                    await this.kv.batchWrite([], deletes);
                }

                // If we fetched fewer than BATCH_LIMIT, we've exhausted the query
                if (result.documents.length < BATCH_LIMIT) {
                    break;
                }
            }

            metadata.documentCount = Math.max(0, metadata.documentCount - totalDeleted);
            await this.saveMetadata(metadata);

            return { acknowledged: true, deletedCount: totalDeleted };
        } finally {
            unlock();
        }
    }

    // ---- Index Management ----

    /**
     * Create an index on a collection field.
     */
    async createIndex(
        collection: string,
        field: string,
        unique: boolean = false,
    ): Promise<CreateIndexResult> {
        validateCollectionName(collection);
        const unlock = await this.getCollectionLock(collection).lock();

        try {
            const metadata = await this.getOrCreateCollection(collection);

            // Check if index already exists
            const existing = metadata.indexes.find((idx) => idx.field === field);
            if (existing) {
                return { acknowledged: true, indexName: existing.name };
            }

            try {
                const indexDef = await this.indexManager.createIndex(
                    metadata,
                    field,
                    unique
                );

                metadata.indexes.push(indexDef);
                await this.saveMetadata(metadata);

                return { acknowledged: true, indexName: indexDef.name };
            } catch (err) {
                if (err instanceof IndexError) {
                    throw new DocumentStoreError(err.code, err.message);
                }
                throw err;
            }
        } finally {
            unlock();
        }
    }

    /**
     * Drop an index from a collection.
     */
    async dropIndex(collection: string, indexName: string): Promise<boolean> {
        validateCollectionName(collection);
        const unlock = await this.getCollectionLock(collection).lock();

        try {
            const metadata = await this.getCollection(collection);
            if (!metadata) return false;

            const idx = metadata.indexes.findIndex((i) => i.name === indexName);
            if (idx === -1) return false;
            if (indexName === '_id_') {
                throw new DocumentStoreError(
                    ErrorCodes.InvalidLength,
                    'Cannot drop _id index',
                );
            }

            const field = metadata.indexes[idx].field;
            await this.indexManager.dropIndex(collection, field);
            metadata.indexes.splice(idx, 1);
            await this.saveMetadata(metadata);

            return true;
        } finally {
            unlock();
        }
    }

    /**
     * List indexes for a collection.
     */
    async listIndexes(collection: string): Promise<IndexDefinition[]> {
        const metadata = await this.getCollection(collection);
        return metadata?.indexes || [];
    }

    // ---- Helpers ----

    private generateId(): string {
        // Generate ObjectId-like hex string (24 chars)
        const timestamp = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
        const random = uuidv4().replace(/-/g, '').substring(0, 16);
        return timestamp + random;
    }

    /**
     * Get collection statistics.
     */
    async getStats(collection: string): Promise<{
        documentCount: number;
        indexCount: number;
        storageSizeBytes: number;
    }> {
        const metadata = await this.getCollection(collection);
        if (!metadata) {
            return { documentCount: 0, indexCount: 0, storageSizeBytes: 0 };
        }

        const BATCH_LIMIT = 5000;
        const prefix = docPrefix(collection);
        let lastKey: string | undefined = undefined;
        let storageSizeBytes = 0;

        while (true) {
            const entries = await this.kv.scan({
                prefix,
                startKey: lastKey ? lastKey + '\x00' : undefined,
                limit: BATCH_LIMIT
            });

            if (entries.length === 0) break;

            for (const entry of entries) {
                lastKey = entry.key;
                storageSizeBytes += entry.key.length + entry.value.length;
            }

            if (entries.length < BATCH_LIMIT) break;
        }

        return {
            documentCount: metadata.documentCount,
            indexCount: metadata.indexes.length,
            storageSizeBytes,
        };
    }

    /**
     * Count documents matching a filter.
     * Unlike find(), this bypasses the DEFAULT_QUERY_LIMIT cap to return accurate counts.
     */
    async countDocuments(collection: string, filter: Filter = {}): Promise<number> {
        validateCollectionName(collection);
        sanitizeDocument(filter as Record<string, unknown>);

        const metadata = await this.getCollection(collection);
        if (!metadata) return 0;

        // For empty filter, use the stored document count (O(1))
        if (!filter || Object.keys(filter).length === 0) {
            return metadata.documentCount;
        }

        // For filtered counts, scan with a high limit
        const plan = planQuery(filter, metadata.indexes, collection);
        const result = await executeQuery(this.kv, plan, collection, filter, { limit: 100000 });
        return result.documents.length;
    }
}
