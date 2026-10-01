// Moving a customer's private data into their own private store (option B, P7).
//
// When a customer links a store, their private collections still sit in the
// shared private store. This moves them, one collection at a time, in the
// background: a move copies every document and index entry in batched
// transactions and can take minutes, longer than a request should wait.
// Progress is reported to the dashboard. Writes to the collection being moved
// are paused meanwhile (RoutingAdapter), and the collection's `storeAddress`
// switches over only once its copy is complete, so reads never see half a move.
//
// Jobs live in memory. After a restart, resumeAll() picks up any collection
// still left in the shared store; a move interrupted midway leaves its source
// intact (it is deleted only after the switch), so redoing it is safe.

import type { PrivacyManager } from './privacy-manager.js';
import type { PrivateStoreRegistry } from './private-store-registry.js';
import type { StorageTarget } from './routing-adapter.js';
import type { DocumentStore } from './document-store.js';

export interface StoreMigrationStatus {
    state: 'running' | 'done' | 'failed';
    store: string;
    /** Collections to move in this run. */
    total: number;
    moved: number;
    /** Collection being moved now, while running. */
    current?: string;
    failed: { collection: string; error: string }[];
    startedAt: number;
    finishedAt?: number;
}

interface Migrator {
    migrateCollection(collection: string, target: StorageTarget, switchMode: () => Promise<void>): Promise<number>;
}

const RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

export class StoreMigrations {
    private readonly jobs = new Map<string, StoreMigrationStatus>();
    private readonly running = new Map<string, Promise<void>>();

    constructor(
        private readonly routing: Migrator,
        private readonly privacy: PrivacyManager,
        private readonly registry: PrivateStoreRegistry,
        private readonly documents: Pick<DocumentStore, 'withCollectionMove'>,
        private readonly retryDelayMs = RETRY_DELAY_MS,
    ) {}

    status(wallet: string): StoreMigrationStatus | null {
        return this.jobs.get(wallet.toLowerCase()) ?? null;
    }

    /**
     * Move `wallet`'s private collections that are still in the shared store
     * into its linked store. Returns the running job; a second call while one
     * runs joins it.
     */
    start(wallet: string): Promise<void> {
        const key = wallet.toLowerCase();
        const existing = this.running.get(key);
        if (existing) return existing;
        const job = this.run(key).finally(() => this.running.delete(key));
        this.running.set(key, job);
        return job;
    }

    /** After a restart: resume every wallet with a linked store. */
    async resumeAll(): Promise<void> {
        for (const wallet of await this.registry.linkedWallets()) await this.start(wallet);
    }

    private async run(wallet: string): Promise<void> {
        const linked = await this.registry.storeFor(wallet);
        if (!linked) return;
        const pending: string[] = [];
        for (const collection of await this.privacy.listOwnedCollections(wallet)) {
            const privacy = await this.privacy.getCollectionPrivacy(collection);
            if (privacy?.mode === 'private' && !privacy.storeAddress) pending.push(collection);
        }
        if (pending.length === 0 && this.jobs.has(wallet)) return; // nothing new; keep the last report
        const status: StoreMigrationStatus = { state: 'running', store: linked.address, total: pending.length, moved: 0, failed: [], startedAt: Date.now() };
        this.jobs.set(wallet, status);

        for (const collection of pending) {
            status.current = collection;
            let lastError: unknown;
            for (let attempt = 1; attempt <= RETRIES; attempt++) {
                try {
                    await this.documents.withCollectionMove(collection, () => this.routing.migrateCollection(
                        collection, { store: linked.address }, () => this.privacy.setStoreAddress(collection, linked.address)));
                    lastError = undefined;
                    break;
                } catch (err) {
                    lastError = err;
                    if (attempt < RETRIES) await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
                }
            }
            if (lastError === undefined) {
                status.moved++;
            } else {
                status.failed.push({ collection, error: lastError instanceof Error ? lastError.message : String(lastError) });
                console.warn(`[StoreMigrations] Could not move ${collection} into ${linked.address}:`, status.failed.at(-1)!.error);
            }
        }
        delete status.current;
        status.state = status.failed.length > 0 ? 'failed' : 'done';
        status.finishedAt = Date.now();
    }
}
