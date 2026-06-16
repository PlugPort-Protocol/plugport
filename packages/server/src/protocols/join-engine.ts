// PlugPort JOIN Engine
// Application-level JOIN execution for SQL queries.
// Reads collections from DocumentStore, correlates in-memory, returns merged results.
//
// Strategies:
//   - Hash Join (INNER):    O(N + M), build hash table on smaller collection
//   - Nested Loop (LEFT/RIGHT): O(N × M) worst case, index-assisted when possible
//   - Index-Assisted:       O(N × log(M)) via $in filter on indexed fields
//   - Cartesian (CROSS):   O(N × M), capped at 10K rows

import { DocumentStore } from '../storage/document-store.js';
import type { DocumentWithId, Filter, Projection, SortSpec } from '@plugport/shared';
import type { JoinPlan } from './sql-translator.js';

// ---- Types ----

export interface JoinResult {
    documents: Record<string, unknown>[];
    totalCount: number;
}

// ---- JOIN Engine ----

export class JoinEngine {
    private readonly MAX_CROSS_JOIN_ROWS = 10_000;

    /**
     * Execute a JOIN plan against the DocumentStore.
     * Both collections are read from Monad, joined in-memory, and returned.
     */
    async execute(plan: JoinPlan, store: DocumentStore): Promise<JoinResult> {
        // Fetch both collections
        const leftResult = await store.find(
            plan.leftCollection,
            plan.leftFilter || {},
            {},
        );
        const leftDocs = leftResult.cursor.firstBatch;

        // For INNER/LEFT joins with indexed right-side field, use $in optimization
        let rightDocs: DocumentWithId[];
        if (plan.type !== 'CROSS' && leftDocs.length > 0 && leftDocs.length < 5000) {
            // Extract join keys from left side and use $in filter on right side
            const joinKeys = leftDocs.map(doc => this.getNestedField(doc, plan.onCondition.leftField));
            const uniqueKeys = [...new Set(joinKeys.filter(k => k !== undefined && k !== null))];

            const rightFilter: Filter = {
                ...plan.rightFilter,
                [plan.onCondition.rightField]: { $in: uniqueKeys },
            };
            const rightResult = await store.find(plan.rightCollection, rightFilter, {});
            rightDocs = rightResult.cursor.firstBatch;
        } else {
            // Full scan of right collection
            const rightResult = await store.find(
                plan.rightCollection,
                plan.rightFilter || {},
                {},
            );
            rightDocs = rightResult.cursor.firstBatch;
        }

        // Execute the appropriate join strategy
        let merged: Record<string, unknown>[];
        switch (plan.type) {
            case 'INNER':
                merged = this.hashJoin(leftDocs, rightDocs, plan);
                break;
            case 'LEFT':
                merged = this.leftJoin(leftDocs, rightDocs, plan);
                break;
            case 'RIGHT':
                merged = this.rightJoin(leftDocs, rightDocs, plan);
                break;
            case 'CROSS':
                merged = this.crossJoin(leftDocs, rightDocs);
                break;
            default:
                merged = this.hashJoin(leftDocs, rightDocs, plan);
        }

        // Execute chained JOINs (A JOIN B JOIN C)
        if (plan.additionalJoins && plan.additionalJoins.length > 0) {
            for (const extraJoin of plan.additionalJoins) {
                const extraResult = await store.find(
                    extraJoin.rightCollection,
                    extraJoin.rightFilter || {},
                    {},
                );
                const extraDocs = extraResult.cursor.firstBatch;

                // Re-wrap merged results as DocumentWithId[]
                const leftWrapped = merged.map((doc, i) => ({ _id: `join_${i}`, ...doc })) as DocumentWithId[];

                const extraPlan: JoinPlan = {
                    ...extraJoin,
                    leftCollection: '__intermediate__',
                    leftAlias: plan.leftAlias,
                };

                switch (extraJoin.type) {
                    case 'LEFT':
                        merged = this.leftJoin(leftWrapped, extraDocs, extraPlan);
                        break;
                    case 'RIGHT':
                        merged = this.rightJoin(leftWrapped, extraDocs, extraPlan);
                        break;
                    case 'CROSS':
                        merged = this.crossJoin(leftWrapped, extraDocs);
                        break;
                    default:
                        merged = this.hashJoin(leftWrapped, extraDocs, extraPlan);
                }
            }
        }

        const totalCount = merged.length;

        // Apply sorting
        if (plan.sort) {
            merged = this.applySort(merged, plan.sort);
        }

        // Apply OFFSET/LIMIT
        if (plan.skip) {
            merged = merged.slice(plan.skip);
        }
        if (plan.limit) {
            merged = merged.slice(0, plan.limit);
        }

        // Apply projection
        if (plan.projection) {
            merged = this.applyProjection(merged, plan.projection);
        }

        return { documents: merged, totalCount };
    }

    // ---- Hash Join (INNER) ----

    /**
     * Hash Join: O(N + M) time, O(min(N,M)) memory.
     * Build a hash table on the smaller collection, probe with the larger.
     */
    private hashJoin(
        leftDocs: DocumentWithId[],
        rightDocs: DocumentWithId[],
        plan: JoinPlan,
    ): Record<string, unknown>[] {
        const results: Record<string, unknown>[] = [];

        // Build phase: hash the smaller collection
        const [buildDocs, probeDocs, buildField, probeField, buildAlias, probeAlias, buildIsLeft] =
            leftDocs.length <= rightDocs.length
                ? [leftDocs, rightDocs, plan.onCondition.leftField, plan.onCondition.rightField, plan.leftAlias, plan.rightAlias, true]
                : [rightDocs, leftDocs, plan.onCondition.rightField, plan.onCondition.leftField, plan.rightAlias, plan.leftAlias, false];

        const hashTable = new Map<string, DocumentWithId[]>();
        for (const doc of buildDocs) {
            const key = String(this.getNestedField(doc, buildField) ?? '');
            const bucket = hashTable.get(key);
            if (bucket) {
                bucket.push(doc);
            } else {
                hashTable.set(key, [doc]);
            }
        }

        // Probe phase: iterate the larger collection
        for (const probeDoc of probeDocs) {
            const key = String(this.getNestedField(probeDoc, probeField) ?? '');
            const matches = hashTable.get(key);
            if (matches) {
                for (const buildDoc of matches) {
                    const leftDoc = buildIsLeft ? buildDoc : probeDoc;
                    const rightDoc = buildIsLeft ? probeDoc : buildDoc;
                    results.push(this.mergeDocuments(leftDoc, rightDoc, plan.leftAlias, plan.rightAlias));
                }
            }
        }

        return results;
    }

    // ---- Left Join ----

    /**
     * Left Join: All rows from left, matching rows from right (null if no match).
     */
    private leftJoin(
        leftDocs: DocumentWithId[],
        rightDocs: DocumentWithId[],
        plan: JoinPlan,
    ): Record<string, unknown>[] {
        const results: Record<string, unknown>[] = [];

        // Build hash table on right side
        const hashTable = new Map<string, DocumentWithId[]>();
        for (const doc of rightDocs) {
            const key = String(this.getNestedField(doc, plan.onCondition.rightField) ?? '');
            const bucket = hashTable.get(key);
            if (bucket) {
                bucket.push(doc);
            } else {
                hashTable.set(key, [doc]);
            }
        }

        // For each left doc, find matches or emit null right side
        for (const leftDoc of leftDocs) {
            const key = String(this.getNestedField(leftDoc, plan.onCondition.leftField) ?? '');
            const matches = hashTable.get(key);

            if (matches && matches.length > 0) {
                for (const rightDoc of matches) {
                    results.push(this.mergeDocuments(leftDoc, rightDoc, plan.leftAlias, plan.rightAlias));
                }
            } else {
                // No match — emit left with null right
                results.push(this.mergeDocuments(leftDoc, null, plan.leftAlias, plan.rightAlias));
            }
        }

        return results;
    }

    // ---- Right Join ----

    /**
     * Right Join: All rows from right, matching from left (null if no match).
     * Implemented as left join with swapped sides.
     */
    private rightJoin(
        leftDocs: DocumentWithId[],
        rightDocs: DocumentWithId[],
        plan: JoinPlan,
    ): Record<string, unknown>[] {
        // Swap left and right, then swap aliases back
        const swappedPlan: JoinPlan = {
            ...plan,
            leftCollection: plan.rightCollection,
            rightCollection: plan.leftCollection,
            leftAlias: plan.rightAlias,
            rightAlias: plan.leftAlias,
            onCondition: {
                leftField: plan.onCondition.rightField,
                rightField: plan.onCondition.leftField,
            },
        };

        return this.leftJoin(rightDocs, leftDocs, swappedPlan);
    }

    // ---- Cross Join ----

    /**
     * Cross Join (Cartesian Product): O(N × M).
     * Capped at MAX_CROSS_JOIN_ROWS to prevent OOM.
     */
    private crossJoin(
        leftDocs: DocumentWithId[],
        rightDocs: DocumentWithId[],
    ): Record<string, unknown>[] {
        const maxRows = this.MAX_CROSS_JOIN_ROWS;
        const totalPossible = leftDocs.length * rightDocs.length;

        if (totalPossible > maxRows) {
            throw new Error(
                `CROSS JOIN would produce ${totalPossible.toLocaleString()} rows, exceeding the ` +
                `${maxRows.toLocaleString()} row limit. Add WHERE clauses or use INNER JOIN.`
            );
        }

        const results: Record<string, unknown>[] = [];
        for (const leftDoc of leftDocs) {
            for (const rightDoc of rightDocs) {
                results.push({ ...leftDoc, ...rightDoc });
            }
        }
        return results;
    }

    // ---- Helpers ----

    /**
     * Merge two documents with table-alias prefixed field names.
     * e.g., { u.name: 'Alice', o.total: 100 }
     */
    private mergeDocuments(
        leftDoc: DocumentWithId,
        rightDoc: DocumentWithId | null,
        leftAlias: string,
        rightAlias: string,
    ): Record<string, unknown> {
        const merged: Record<string, unknown> = {};

        // Add left-side fields with alias prefix
        for (const [key, value] of Object.entries(leftDoc)) {
            if (key === '_id') continue;
            merged[`${leftAlias}.${key}`] = value;
            merged[key] = value; // Also add unqualified for simple queries
        }
        merged[`${leftAlias}._id`] = leftDoc._id;

        // Add right-side fields with alias prefix
        if (rightDoc) {
            for (const [key, value] of Object.entries(rightDoc)) {
                if (key === '_id') continue;
                merged[`${rightAlias}.${key}`] = value;
                // Only add unqualified if not already present from left side
                if (!(key in merged) || key === '_id') {
                    merged[key] = value;
                }
            }
            merged[`${rightAlias}._id`] = rightDoc._id;
        } else {
            // NULL right side for LEFT JOIN
            merged[`${rightAlias}._id`] = null;
        }

        return merged;
    }

    /**
     * Get a nested field value from a document.
     * Supports dot notation: "user.name" → doc.user.name
     */
    private getNestedField(doc: Record<string, unknown>, field: string): unknown {
        const parts = field.split('.');
        let current: unknown = doc;
        for (const part of parts) {
            if (current === null || current === undefined || typeof current !== 'object') {
                return undefined;
            }
            current = (current as Record<string, unknown>)[part];
        }
        return current;
    }

    /**
     * Sort merged documents by a SortSpec.
     */
    private applySort(docs: Record<string, unknown>[], sort: SortSpec): Record<string, unknown>[] {
        const entries = Object.entries(sort);
        return [...docs].sort((a, b) => {
            for (const [field, direction] of entries) {
                const aVal = this.getNestedField(a, field);
                const bVal = this.getNestedField(b, field);
                if (aVal === bVal) continue;
                if (aVal === null || aVal === undefined) return direction;
                if (bVal === null || bVal === undefined) return -direction;
                if (aVal < bVal) return -direction;
                if (aVal > bVal) return direction;
            }
            return 0;
        });
    }

    /**
     * Apply projection to merged documents.
     */
    private applyProjection(docs: Record<string, unknown>[], projection: Projection): Record<string, unknown>[] {
        const fields = Object.keys(projection).filter(f => projection[f] === 1);
        if (fields.length === 0) return docs;

        return docs.map(doc => {
            const projected: Record<string, unknown> = {};
            for (const field of fields) {
                // Try qualified name (alias.field), then unqualified
                if (field in doc) {
                    projected[field] = doc[field];
                } else {
                    // Search for the field in any alias prefix
                    for (const [key, value] of Object.entries(doc)) {
                        if (key.endsWith(`.${field}`)) {
                            projected[field] = value;
                            break;
                        }
                    }
                }
            }
            return projected;
        });
    }
}
