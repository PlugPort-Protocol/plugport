// PlugPort Per-API-Key Analytics Recorder
// Lightweight, day-bucketed analytics for each API key.
// Records operation counts, latency sums, error counts, and payload sizes.
// Aggregates by: day → operation type → collection.
//
// Storage format:
//   analytics:<keyHash>:<YYYYMMDD>:summary  → { requests, errors, totalLatencyMs, totalBytes }
//   analytics:<keyHash>:<YYYYMMDD>:ops      → { find: N, insert: N, update: N, delete: N, ... }
//   analytics:<keyHash>:<YYYYMMDD>:cols     → { "users": N, "orders": N, ... }
//   analytics:<keyHash>:lifetime            → { totalRequests, firstSeen, lastSeen }

import type { KVAdapter } from '@plugport/shared';

// ---- Types ----

export interface AnalyticsEvent {
    /** Operation type (find, insert, update, delete, createIndex, etc.) */
    operation: string;
    /** Target collection (if applicable) */
    collection?: string;
    /** Request latency in milliseconds */
    latencyMs: number;
    /** HTTP status code */
    statusCode: number;
    /** Approximate payload size in bytes */
    payloadBytes?: number;
    /** Timestamp (defaults to now) */
    timestamp?: number;
}

export interface DaySummary {
    date: string;
    requests: number;
    errors: number;
    totalLatencyMs: number;
    totalBytes: number;
    avgLatencyMs: number;
    errorRate: number;
}

export interface OperationBreakdown {
    [operation: string]: number;
}

export interface CollectionBreakdown {
    [collection: string]: number;
}

export interface KeyAnalytics {
    keyHash: string;
    totalRequests: number;
    firstSeen: number;
    lastSeen: number;
    /** Last N days of summary data */
    daily: DaySummary[];
    /** Operation type breakdown (all time for requested period) */
    operations: OperationBreakdown;
    /** Top collections by request count */
    collections: CollectionBreakdown;
}

// ---- Analytics Recorder ----

export class AnalyticsRecorder {
    private kvStore: KVAdapter;
    private prefix: string;

    constructor(kvStore: KVAdapter, options?: { prefix?: string }) {
        this.kvStore = kvStore;
        this.prefix = options?.prefix || 'analytics:';
    }

    /**
     * Record a single API request event for a key.
     * This is called from the auth middleware after each request.
     * Uses atomic increment pattern (read-modify-write).
     */
    async record(keyHash: string, event: AnalyticsEvent): Promise<void> {
        const ts = event.timestamp || Date.now();
        const dateStr = this.formatDate(ts);
        const isError = event.statusCode >= 400;

        // 1. Update daily summary
        const summaryKey = `${this.prefix}${keyHash}:${dateStr}:summary`;
        const summary = await this.getJson<{
            requests: number;
            errors: number;
            totalLatencyMs: number;
            totalBytes: number;
        }>(summaryKey) || { requests: 0, errors: 0, totalLatencyMs: 0, totalBytes: 0 };

        summary.requests++;
        if (isError) summary.errors++;
        summary.totalLatencyMs += event.latencyMs;
        summary.totalBytes += event.payloadBytes || 0;

        await this.putJson(summaryKey, summary);

        // 2. Update operation breakdown
        const opsKey = `${this.prefix}${keyHash}:${dateStr}:ops`;
        const ops = await this.getJson<OperationBreakdown>(opsKey) || {};
        ops[event.operation] = (ops[event.operation] || 0) + 1;
        await this.putJson(opsKey, ops);

        // 3. Update collection breakdown
        if (event.collection) {
            const colsKey = `${this.prefix}${keyHash}:${dateStr}:cols`;
            const cols = await this.getJson<CollectionBreakdown>(colsKey) || {};
            cols[event.collection] = (cols[event.collection] || 0) + 1;
            await this.putJson(colsKey, cols);
        }

        // 4. Update lifetime stats
        const lifetimeKey = `${this.prefix}${keyHash}:lifetime`;
        const lifetime = await this.getJson<{
            totalRequests: number;
            firstSeen: number;
            lastSeen: number;
        }>(lifetimeKey) || { totalRequests: 0, firstSeen: ts, lastSeen: ts };

        lifetime.totalRequests++;
        lifetime.lastSeen = ts;
        await this.putJson(lifetimeKey, lifetime);
    }

    /**
     * Get aggregated analytics for a key over the last N days.
     *
     * @param keyHash SHA-256 hash of the API key
     * @param days Number of days to include (default: 7)
     */
    async getAnalytics(keyHash: string, days: number = 7): Promise<KeyAnalytics> {
        const lifetime = await this.getJson<{
            totalRequests: number;
            firstSeen: number;
            lastSeen: number;
        }>(`${this.prefix}${keyHash}:lifetime`) || { totalRequests: 0, firstSeen: 0, lastSeen: 0 };

        const daily: DaySummary[] = [];
        const allOps: OperationBreakdown = {};
        const allCols: CollectionBreakdown = {};

        const now = Date.now();
        for (let i = 0; i < days; i++) {
            const date = this.formatDate(now - i * 86400000);

            // Day summary
            const summary = await this.getJson<{
                requests: number;
                errors: number;
                totalLatencyMs: number;
                totalBytes: number;
            }>(`${this.prefix}${keyHash}:${date}:summary`);

            if (summary) {
                daily.push({
                    date,
                    requests: summary.requests,
                    errors: summary.errors,
                    totalLatencyMs: summary.totalLatencyMs,
                    totalBytes: summary.totalBytes,
                    avgLatencyMs: summary.requests > 0 ? summary.totalLatencyMs / summary.requests : 0,
                    errorRate: summary.requests > 0 ? summary.errors / summary.requests : 0,
                });
            } else {
                daily.push({
                    date,
                    requests: 0,
                    errors: 0,
                    totalLatencyMs: 0,
                    totalBytes: 0,
                    avgLatencyMs: 0,
                    errorRate: 0,
                });
            }

            // Merge operation breakdowns
            const ops = await this.getJson<OperationBreakdown>(
                `${this.prefix}${keyHash}:${date}:ops`,
            );
            if (ops) {
                for (const [op, count] of Object.entries(ops)) {
                    allOps[op] = (allOps[op] || 0) + count;
                }
            }

            // Merge collection breakdowns
            const cols = await this.getJson<CollectionBreakdown>(
                `${this.prefix}${keyHash}:${date}:cols`,
            );
            if (cols) {
                for (const [col, count] of Object.entries(cols)) {
                    allCols[col] = (allCols[col] || 0) + count;
                }
            }
        }

        return {
            keyHash,
            totalRequests: lifetime.totalRequests,
            firstSeen: lifetime.firstSeen,
            lastSeen: lifetime.lastSeen,
            daily: daily.reverse(), // Oldest first
            operations: allOps,
            collections: allCols,
        };
    }

    /**
     * Get a quick overview of analytics for all keys owned by an address.
     * Returns total requests and key count.
     */
    async getOverviewForOwner(
        keyHashes: string[],
    ): Promise<{ totalRequests: number; totalKeys: number; activeKeys: number }> {
        let totalRequests = 0;
        let activeKeys = 0;

        for (const hash of keyHashes) {
            const lifetime = await this.getJson<{
                totalRequests: number;
                firstSeen: number;
                lastSeen: number;
            }>(`${this.prefix}${hash}:lifetime`);

            if (lifetime) {
                totalRequests += lifetime.totalRequests;
                activeKeys++;
            }
        }

        return { totalRequests, totalKeys: keyHashes.length, activeKeys };
    }

    // ---- Helpers ----

    private formatDate(ts: number): string {
        const d = new Date(ts);
        return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    }

    private async getJson<T>(key: string): Promise<T | null> {
        const data = await this.kvStore.get(key);
        if (!data) return null;
        try {
            return JSON.parse(data.toString()) as T;
        } catch (err) {
            console.warn(`[Analytics] Malformed JSON for key "${key}":`, err instanceof Error ? err.message : 'parse error');
            return null;
        }
    }

    private async putJson(key: string, value: unknown): Promise<void> {
        await this.kvStore.put(key, Buffer.from(JSON.stringify(value)));
    }
}
