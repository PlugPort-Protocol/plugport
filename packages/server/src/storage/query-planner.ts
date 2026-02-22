// PlugPort Query Planner
// Analyzes filters to select optimal query execution strategy:
// index scan (equality/range) vs collection scan

import type { KVAdapter, Filter, SortSpec, Projection, DocumentWithId, IndexDefinition } from '@plugport/shared';
import {
    docPrefix,
    idxPrefix,
    encodeValue,
    computeIndexRange,
    encodeDocKey,
    decodeIdxKey,
} from './key-encoding.js';

export interface QueryPlan {
    type: 'indexScan' | 'collectionScan';
    indexField?: string;
    indexName?: string;
    startKey?: string;
    endKey?: string;
    needsPostFilter: boolean;
    estimatedCost: number;
}

export interface QueryExecutionResult {
    documents: DocumentWithId[];
    scannedDocuments: number;
    usedIndex: string | null;
    executionTimeMs: number;
}

/**
 * Analyzes a filter to determine if we can use an index.
 */
export function planQuery(
    filter: Filter,
    indexes: IndexDefinition[],
    collection: string,
): QueryPlan {
    if (!filter || Object.keys(filter).length === 0) {
        return {
            type: 'collectionScan',
            needsPostFilter: false,
            estimatedCost: 1000,
        };
    }

    // Look for fields that have an index
    for (const [field, condition] of Object.entries(filter)) {
        if (field.startsWith('$')) continue; // Skip operators like $and

        const index = indexes.find((idx) => idx.field === field);
        if (!index) continue;

        // Determine scan range
        if (typeof condition === 'object' && condition !== null && !Array.isArray(condition)) {
            // Range query: { field: { $gt: x, $lt: y } }
            const ops = condition as Record<string, unknown>;
            const hasComparison = '$gt' in ops || '$gte' in ops || '$lt' in ops || '$lte' in ops || '$eq' in ops;

            if (hasComparison) {
                const range = computeIndexRange(collection, field, ops);
                const otherFields = Object.keys(filter).filter((f) => f !== field && !f.startsWith('$'));

                return {
                    type: 'indexScan',
                    indexField: field,
                    indexName: index.name,
                    startKey: range.startKey,
                    endKey: range.endKey,
                    needsPostFilter: otherFields.length > 0,
                    estimatedCost: 10,
                };
            }
        } else {
            // Exact match: { field: value }
            const range = computeIndexRange(collection, field, { $eq: condition });
            const otherFields = Object.keys(filter).filter((f) => f !== field && !f.startsWith('$'));

            return {
                type: 'indexScan',
                indexField: field,
                indexName: index.name,
                startKey: range.startKey,
                endKey: range.endKey,
                needsPostFilter: otherFields.length > 0,
                estimatedCost: 1,
            };
        }
    }

    // Handle $and operator
    if (filter.$and && Array.isArray(filter.$and)) {
        for (const subFilter of filter.$and) {
            const plan = planQuery(subFilter, indexes, collection);
            if (plan.type === 'indexScan') {
                plan.needsPostFilter = true; // Other conditions need post-filtering
                return plan;
            }
        }
    }

    // Handle $or operator: check if any branch can use an index
    if (filter.$or && Array.isArray(filter.$or)) {
        for (const subFilter of filter.$or) {
            const plan = planQuery(subFilter, indexes, collection);
            if (plan.type === 'indexScan') {
                plan.needsPostFilter = true; // Full post-filtering required for $or
                return plan;
            }
        }
    }

    // No index available, fall back to collection scan
    return {
        type: 'collectionScan',
        needsPostFilter: true,
        estimatedCost: 1000,
    };
}

/**
 * Execute a query plan against the KV store.
 */
export async function executeQuery(
    kv: KVAdapter,
    plan: QueryPlan,
    collection: string,
    filter: Filter,
    options: {
        projection?: Projection;
        sort?: SortSpec;
        limit?: number;
        skip?: number;
    } = {},
): Promise<QueryExecutionResult> {
    const startTime = Date.now();
    let documents: DocumentWithId[] = [];
    let scannedDocuments = 0;

    // Determine the maximum number of documents we need before we can stop scanning
    // If there is a sort option, we must scan everything to sort correctly.
    // If no limit is provided, we map undefined representing un-bounded searches
    let maxNeeded = options.sort || options.limit === undefined
        ? undefined
        : ((options.skip || 0) + options.limit);

    const MAX_SORT_EVAL_LIMIT = 50000;
    if (maxNeeded === undefined && options.sort) {
        maxNeeded = MAX_SORT_EVAL_LIMIT;
    }

    const BATCH_LIMIT = 5000;

    if (plan.type === 'indexScan' && plan.startKey && plan.endKey) {
        // Index scan: get document IDs from index, then fetch documents in chunks
        let lastKey: string | undefined = plan.startKey;

        while (true) {
            const indexEntries = await kv.scan({
                startKey: lastKey,
                endKey: plan.endKey,
                limit: BATCH_LIMIT,
            });

            if (indexEntries.length === 0) break;

            for (const entry of indexEntries) {
                // We use lastKey + \x00 for the next iteration if we need it to be exclusive
                // However, our scan implementation is usually inclusive for startKey. 
                // We must be careful not to process the same key twice.
                // An easy way is to keep track, but here we just pass the next key or let the KV adapter handle pagination properly.
                // Assuming KV adapter includes startKey, we advance it by appending \x00
                lastKey = entry.key + '\x00';

                const decoded = decodeIdxKey(entry.key);
                if (!decoded) continue;
                const docKey = encodeDocKey(collection, decoded.id);
                const docData = await kv.get(docKey);

                if (docData) {
                    scannedDocuments++;
                    const doc = JSON.parse(docData.toString()) as DocumentWithId;

                    if (!plan.needsPostFilter || matchesFilter(doc, filter)) {
                        documents.push(doc);
                        if (maxNeeded !== undefined && documents.length >= maxNeeded) break;
                    }
                }
            }

            if (maxNeeded !== undefined && documents.length >= maxNeeded) break;
            if (indexEntries.length < BATCH_LIMIT) break;
        }
    } else {
        // Collection scan: iterate all documents in chunks
        const prefix = docPrefix(collection);
        let lastKey: string | undefined = undefined;

        while (true) {
            const entries = await kv.scan({
                prefix,
                startKey: lastKey ? lastKey + '\x00' : undefined,
                limit: BATCH_LIMIT
            });

            if (entries.length === 0) break;

            for (const entry of entries) {
                lastKey = entry.key;
                scannedDocuments++;
                const doc = JSON.parse(entry.value.toString()) as DocumentWithId;

                if (!plan.needsPostFilter || matchesFilter(doc, filter)) {
                    documents.push(doc);
                    if (maxNeeded !== undefined && documents.length >= maxNeeded) break;
                }
            }

            if (maxNeeded !== undefined && documents.length >= maxNeeded) break;
            if (entries.length < BATCH_LIMIT) break;
        }
    }

    // Apply sort
    if (options.sort) {
        documents = applySorting(documents, options.sort);
    }

    // Apply skip
    if (options.skip && options.skip > 0) {
        documents = documents.slice(options.skip);
    }

    // Apply limit
    if (options.limit && options.limit > 0) {
        documents = documents.slice(0, options.limit);
    }

    // Apply projection
    if (options.projection) {
        documents = documents.map((doc) => applyProjection(doc, options.projection!));
    }

    return {
        documents,
        scannedDocuments,
        usedIndex: plan.indexName || null,
        executionTimeMs: Date.now() - startTime,
    };
}

/**
 * Check if a document matches a filter.
 */
export function matchesFilter(doc: Record<string, unknown>, filter: Filter): boolean {
    if (!filter || Object.keys(filter).length === 0) return true;

    for (const [field, condition] of Object.entries(filter)) {
        if (field === '$and') {
            if (Array.isArray(condition)) {
                for (const subFilter of condition as Filter[]) {
                    if (!matchesFilter(doc, subFilter)) return false;
                }
            }
            continue;
        }

        if (field === '$or') {
            if (Array.isArray(condition)) {
                const orFilters = condition as Filter[];
                if (orFilters.length > 0 && !orFilters.some((sub) => matchesFilter(doc, sub))) {
                    return false;
                }
            }
            continue;
        }

        const docValue = getNestedField(doc, field);

        if (typeof condition === 'object' && condition !== null && !Array.isArray(condition)) {
            const ops = condition as Record<string, unknown>;
            if (!matchesComparison(docValue, ops)) return false;
        } else {
            // Exact match
            if (!deepEquals(docValue, condition)) return false;
        }
    }

    return true;
}

function matchesComparison(value: unknown, ops: Record<string, unknown>): boolean {
    for (const [op, target] of Object.entries(ops)) {
        switch (op) {
            case '$eq':
                if (!deepEquals(value, target)) return false;
                break;
            case '$ne':
                if (deepEquals(value, target)) return false;
                break;
            case '$gt':
                if (value === null || value === undefined || !compareValues(value, target, '>')) return false;
                break;
            case '$gte':
                if (value === null || value === undefined || !compareValues(value, target, '>=')) return false;
                break;
            case '$lt':
                if (value === null || value === undefined || !compareValues(value, target, '<')) return false;
                break;
            case '$lte':
                if (value === null || value === undefined || !compareValues(value, target, '<=')) return false;
                break;
            case '$in':
                if (Array.isArray(target)) {
                    if (target.length > 2000) {
                        throw new Error('Query exceeds maximum $in array limit of 2000');
                    }
                    if (!target.some((t) => deepEquals(value, t))) return false;
                }
                break;
            case '$nin':
                if (Array.isArray(target)) {
                    if (target.length > 2000) {
                        throw new Error('Query exceeds maximum $nin array limit of 2000');
                    }
                    if (target.some((t) => deepEquals(value, t))) return false;
                }
                break;
            case '$exists': {
                const shouldExist = Boolean(target);
                const doesExist = value !== undefined;
                if (shouldExist !== doesExist) return false;
                break;
            }
        }
    }
    return true;
}

function compareValues(a: unknown, b: unknown, op: '>' | '>=' | '<' | '<='): boolean {
    const numA = Number(a);
    const numB = Number(b);

    if (!isNaN(numA) && !isNaN(numB)) {
        switch (op) {
            case '>': return numA > numB;
            case '>=': return numA >= numB;
            case '<': return numA < numB;
            case '<=': return numA <= numB;
        }
    }

    const strA = String(a);
    const strB = String(b);
    switch (op) {
        case '>': return strA > strB;
        case '>=': return strA >= strB;
        case '<': return strA < strB;
        case '<=': return strA <= strB;
    }
}

function getNestedField(doc: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = doc;
    for (const part of parts) {
        if (current === null || current === undefined || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}

function deepEquals(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;

    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!deepEquals(a[i], b[i])) return false;
        }
        return true;
    }

    if (typeof a === 'object' && typeof b === 'object') {
        const keysA = Object.keys(a as Record<string, unknown>);
        const keysB = Object.keys(b as Record<string, unknown>);
        if (keysA.length !== keysB.length) return false;
        for (const key of keysA) {
            if (!keysB.includes(key)) return false;
            if (!deepEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
        }
        return true;
    }

    return false;
}

function applySorting(docs: DocumentWithId[], sort: SortSpec): DocumentWithId[] {
    const sortFields = Object.entries(sort);
    return [...docs].sort((a, b) => {
        for (const [field, direction] of sortFields) {
            const aVal = getNestedField(a, field);
            const bVal = getNestedField(b, field);

            let cmp = 0;
            if (aVal === bVal) cmp = 0;
            else if (aVal === undefined || aVal === null) cmp = -1;
            else if (bVal === undefined || bVal === null) cmp = 1;
            else if (typeof aVal === 'number' && typeof bVal === 'number') cmp = aVal - bVal;
            else cmp = String(aVal).localeCompare(String(bVal));

            if (cmp !== 0) return cmp * direction;
        }
        return 0;
    });
}

function applyProjection(doc: DocumentWithId, projection: Projection): DocumentWithId {
    const fields = Object.entries(projection);
    if (fields.length === 0) return doc;

    const isInclusion = fields.some(([, v]) => v === 1);
    const result: DocumentWithId = { _id: doc._id };

    if (isInclusion) {
        // Include only specified fields (plus _id unless excluded)
        for (const [field, include] of fields) {
            if (field === '_id' && include === 0) {
                delete (result as Record<string, unknown>)._id;
                continue;
            }
            if (include === 1 && field in doc) {
                (result as Record<string, unknown>)[field] = doc[field];
            }
        }
    } else {
        // Exclude specified fields
        Object.assign(result, doc);
        for (const [field, exclude] of fields) {
            if (exclude === 0 && field !== '_id') {
                delete (result as Record<string, unknown>)[field];
            }
        }
    }

    return result;
}
