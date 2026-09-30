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
//
// Writes are batched. On the Monad adapter every put is a transaction paid by
// the Store gas-station wallet, and recording each request directly cost up to
// four transactions per request: a dashboard left open (it polls every 5s)
// sent ~750 a day, which drained the wallet's 25 MON in nine days and stopped
// all document writes. record() now only adds to in-memory counters; flush()
// merges them into the stored values in one batchWrite every
// ANALYTICS_FLUSH_INTERVAL_MS (default 15 minutes), and skips when idle.
// Reads include unflushed counts. A failed flush keeps its counts for the next.

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

/** Additive counters: a day's summary, ops and cols values all merge by summing. */
type Counts = Record<string, number>;

interface Lifetime {
    totalRequests: number;
    firstSeen: number;
    lastSeen: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 15 * 60 * 1000;
/** Flush early if this many storage keys are pending (many distinct keys/days). */
const MAX_PENDING_KEYS = 5000;

// ---- Analytics Recorder ----

export class AnalyticsRecorder {
    private kvStore: KVAdapter;
    private prefix: string;

    /** Unflushed increments, by storage key. */
    private pendingCounts = new Map<string, Counts>();
    private pendingLifetimes = new Map<string, Lifetime>();
    private flushing: Promise<void> | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;

    /**
     * @param options.flushIntervalMs How often pending counts are written.
     *   Default: ANALYTICS_FLUSH_INTERVAL_MS, else 15 minutes. 0 disables the
     *   timer (call flush() yourself).
     */
    constructor(kvStore: KVAdapter, options?: { prefix?: string; flushIntervalMs?: number }) {
        this.kvStore = kvStore;
        this.prefix = options?.prefix || 'analytics:';
        const configured = Number(process.env.ANALYTICS_FLUSH_INTERVAL_MS);
        const interval = options?.flushIntervalMs ?? (configured > 0 ? configured : DEFAULT_FLUSH_INTERVAL_MS);
        if (interval > 0) {
            this.timer = setInterval(() => { void this.flush(); }, interval);
            this.timer.unref?.();
        }
    }

    /**
     * Record a single API request event for a key. Called after each request;
     * only updates in-memory counters — nothing is written until flush().
     */
    async record(keyHash: string, event: AnalyticsEvent): Promise<void> {
        const ts = event.timestamp || Date.now();
        const dateStr = this.formatDate(ts);
        const base = `${this.prefix}${keyHash}`;

        this.addCounts(`${base}:${dateStr}:summary`, {
            requests: 1,
            errors: event.statusCode >= 400 ? 1 : 0,
            totalLatencyMs: event.latencyMs,
            totalBytes: event.payloadBytes || 0,
        });
        this.addCounts(`${base}:${dateStr}:ops`, { [event.operation]: 1 });
        if (event.collection) this.addCounts(`${base}:${dateStr}:cols`, { [event.collection]: 1 });
        this.addLifetime(`${base}:lifetime`, { totalRequests: 1, firstSeen: ts, lastSeen: ts });

        if (this.pendingCounts.size + this.pendingLifetimes.size >= MAX_PENDING_KEYS) void this.flush();
    }

    /**
     * Merge pending counts into the stored values and write them in one batch.
     * Single-flight; a no-op when nothing is pending. On failure the counts are
     * kept for the next flush. While a flush is in flight, reads may briefly
     * undercount the requests it carries.
     */
    async flush(): Promise<void> {
        if (this.flushing) return this.flushing;
        if (this.pendingCounts.size === 0 && this.pendingLifetimes.size === 0) return;

        const counts = this.pendingCounts;
        const lifetimes = this.pendingLifetimes;
        this.pendingCounts = new Map();
        this.pendingLifetimes = new Map();

        this.flushing = (async () => {
            try {
                const puts: { key: string; value: Buffer }[] = [];
                for (const [key, delta] of counts) {
                    const merged = sumCounts((await this.getJson<Counts>(key)) || {}, delta);
                    puts.push({ key, value: Buffer.from(JSON.stringify(merged)) });
                }
                for (const [key, delta] of lifetimes) {
                    const stored = await this.getJson<Lifetime>(key);
                    puts.push({ key, value: Buffer.from(JSON.stringify(stored ? mergeLifetime(stored, delta) : delta)) });
                }
                if (this.kvStore.batchWrite) {
                    await this.kvStore.batchWrite(puts, []);
                } else {
                    for (const { key, value } of puts) await this.kvStore.put(key, value);
                }
            } catch (err) {
                for (const [key, delta] of counts) this.addCounts(key, delta);
                for (const [key, delta] of lifetimes) this.addLifetime(key, delta);
                console.warn('[Analytics] Flush failed, will retry next interval:', err instanceof Error ? err.message : 'unknown');
            } finally {
                this.flushing = null;
            }
        })();
        return this.flushing;
    }

    /** Stop the timer and write whatever is pending (call on shutdown). */
    async close(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        await this.flushing;
        await this.flush();
    }

    /**
     * Get aggregated analytics for a key over the last N days.
     *
     * @param keyHash SHA-256 hash of the API key
     * @param days Number of days to include (default: 7)
     */
    async getAnalytics(keyHash: string, days: number = 7): Promise<KeyAnalytics> {
        const lifetime = await this.readLifetime(`${this.prefix}${keyHash}:lifetime`)
            || { totalRequests: 0, firstSeen: 0, lastSeen: 0 };

        const daily: DaySummary[] = [];
        const allOps: OperationBreakdown = {};
        const allCols: CollectionBreakdown = {};

        const now = Date.now();
        for (let i = 0; i < days; i++) {
            const date = this.formatDate(now - i * 86400000);

            // Day summary
            const summary = await this.readCounts(`${this.prefix}${keyHash}:${date}:summary`);

            if (summary) {
                daily.push({
                    date,
                    requests: summary.requests || 0,
                    errors: summary.errors || 0,
                    totalLatencyMs: summary.totalLatencyMs || 0,
                    totalBytes: summary.totalBytes || 0,
                    avgLatencyMs: summary.requests > 0 ? summary.totalLatencyMs / summary.requests : 0,
                    errorRate: summary.requests > 0 ? (summary.errors || 0) / summary.requests : 0,
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
            const ops = await this.readCounts(`${this.prefix}${keyHash}:${date}:ops`);
            if (ops) {
                for (const [op, count] of Object.entries(ops)) {
                    allOps[op] = (allOps[op] || 0) + count;
                }
            }

            // Merge collection breakdowns
            const cols = await this.readCounts(`${this.prefix}${keyHash}:${date}:cols`);
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
            const lifetime = await this.readLifetime(`${this.prefix}${hash}:lifetime`);

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

    /** Stored counts plus anything not yet flushed; null when neither exists. */
    private async readCounts(key: string): Promise<Counts | null> {
        const stored = await this.getJson<Counts>(key);
        const pending = this.pendingCounts.get(key);
        if (!stored && !pending) return null;
        return sumCounts(stored || {}, pending || {});
    }

    private async readLifetime(key: string): Promise<Lifetime | null> {
        const stored = await this.getJson<Lifetime>(key);
        const pending = this.pendingLifetimes.get(key);
        if (!stored || !pending) return stored || pending || null;
        return mergeLifetime(stored, pending);
    }

    private addCounts(key: string, delta: Counts): void {
        this.pendingCounts.set(key, sumCounts(this.pendingCounts.get(key) || {}, delta));
    }

    private addLifetime(key: string, delta: Lifetime): void {
        const current = this.pendingLifetimes.get(key);
        this.pendingLifetimes.set(key, current ? mergeLifetime(current, delta) : { ...delta });
    }
}

function sumCounts(a: Counts, b: Counts): Counts {
    const out: Counts = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = (out[k] || 0) + v;
    return out;
}

function mergeLifetime(a: Lifetime, b: Lifetime): Lifetime {
    return {
        totalRequests: a.totalRequests + b.totalRequests,
        firstSeen: Math.min(a.firstSeen, b.firstSeen),
        lastSeen: Math.max(a.lastSeen, b.lastSeen),
    };
}
