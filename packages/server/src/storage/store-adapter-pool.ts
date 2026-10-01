// Storage adapters for customers' own private stores (option B).
//
// One adapter per store contract, created on first use rather than at startup,
// so the number of customer stores doesn't slow restarts (each adapter loads
// its key index when first touched). An adapter is dropped only after it has
// been idle for a long time. There is deliberately no eviction under pressure:
// dropping an adapter with a write in flight and recreating it could allocate
// the same key-log sequence number twice, which would make a key undiscoverable
// after the next restart.

import type { KVAdapter } from '@plugport/shared';

const DEFAULT_IDLE_MS = 30 * 60 * 1000;

export class StoreAdapterPool {
    private readonly adapters = new Map<string, { adapter: KVAdapter; lastUsed: number }>();
    private readonly timer: ReturnType<typeof setInterval>;

    /**
     * @param create Builds the adapter for one store (encryption over the chain adapter).
     * @param idleMs Drop an adapter unused for this long.
     */
    constructor(private readonly create: (storeAddress: string) => KVAdapter, private readonly idleMs = DEFAULT_IDLE_MS) {
        this.timer = setInterval(() => this.sweep(), Math.min(idleMs, 5 * 60 * 1000));
        this.timer.unref?.();
    }

    get(storeAddress: string): KVAdapter {
        const key = storeAddress.toLowerCase();
        let entry = this.adapters.get(key);
        if (!entry) {
            entry = { adapter: this.create(storeAddress), lastUsed: Date.now() };
            this.adapters.set(key, entry);
        }
        entry.lastUsed = Date.now();
        return entry.adapter;
    }

    get size(): number {
        return this.adapters.size;
    }

    /** Drop adapters idle for longer than idleMs. */
    sweep(now = Date.now()): void {
        for (const [key, entry] of this.adapters) {
            if (now - entry.lastUsed >= this.idleMs) this.adapters.delete(key);
        }
    }

    close(): void {
        clearInterval(this.timer);
    }
}
