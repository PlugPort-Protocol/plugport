// Moving collections created before per-wallet namespaces into their owner's
// namespace: `users` owned by 0xabc… becomes `0xabc….users` (see namespaces.ts).
//
// Until a collection is moved it resolves exactly as if it already had been,
// so nothing waits on this; it runs in the background after startup. Each move
// copies the documents and indexes with the collection's writes paused, then
// marks the old record `movedTo` (from then on the new name serves it), then
// deletes the old copy and its record. A restart midway is safe: before the
// mark, the old collection is still authoritative and the copy is redone; after
// it, only the cleanup is left. Unowned collections (the shared demo data)
// stay where they are.

import type { DocumentStore } from './document-store.js';
import type { PrivacyManager } from './privacy-manager.js';
import { qualify, type Namespaces } from './namespaces.js';

export interface NamespaceMigrationStatus {
    state: 'idle' | 'running' | 'done' | 'failed';
    total: number;
    moved: number;
    failed: { collection: string; error: string }[];
}

const RETRIES = 3;
const RETRY_DELAY_MS = 5_000;

export class NamespaceMigration {
    private current: NamespaceMigrationStatus = { state: 'idle', total: 0, moved: 0, failed: [] };
    private running?: Promise<NamespaceMigrationStatus>;

    constructor(
        private readonly store: Pick<DocumentStore, 'renameCollection' | 'dropCollection'>,
        private readonly privacy: Pick<PrivacyManager, 'listRecords' | 'copyRecord' | 'markMoved' | 'deleteRecord'>,
        private readonly namespaces: Namespaces,
        private readonly retryDelayMs = RETRY_DELAY_MS,
    ) {}

    status(): NamespaceMigrationStatus {
        return this.current;
    }

    /** Move every legacy collection; a second call while one runs joins it. */
    run(): Promise<NamespaceMigrationStatus> {
        this.running ??= this.moveAll().finally(() => { this.running = undefined; });
        return this.running;
    }

    private async moveAll(): Promise<NamespaceMigrationStatus> {
        // Interrupted moves first: their data is already at the new name.
        const cleanup = (await this.privacy.listRecords()).filter((r) => r.record.movedTo);
        const pending = this.namespaces.legacyCollections();
        const status: NamespaceMigrationStatus = { state: 'running', total: cleanup.length + pending.length, moved: 0, failed: [] };
        this.current = status;

        for (const { collection } of cleanup) {
            await this.attempt(status, collection, async () => {
                await this.store.dropCollection(collection);
                await this.privacy.deleteRecord(collection);
                this.namespaces.forget(collection);
            });
        }
        for (const [collection, owner] of pending) {
            const target = qualify(owner, collection);
            // Once switched over, a retry must only finish the cleanup: copying
            // again from a half-deleted original would replace the full copy.
            let switched = false;
            await this.attempt(status, collection, async () => {
                if (switched) {
                    await this.store.dropCollection(collection);
                } else {
                    await this.store.renameCollection(collection, target, {
                        prepare: () => this.privacy.copyRecord(collection, target),
                        switchOver: async () => {
                            await this.privacy.markMoved(collection, target);
                            this.namespaces.retire(collection);
                            switched = true;
                        },
                    });
                }
                await this.privacy.deleteRecord(collection);
                this.namespaces.forget(collection);
            });
        }

        status.state = status.failed.length > 0 ? 'failed' : 'done';
        if (status.total > 0) {
            console.log(`  [Namespaces] Moved ${status.moved}/${status.total} legacy collections into their owners' namespaces`
                + (status.failed.length > 0 ? `; ${status.failed.length} failed (retried at the next start)` : ''));
        }
        return status;
    }

    private async attempt(status: NamespaceMigrationStatus, collection: string, move: () => Promise<void>): Promise<void> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= RETRIES; attempt++) {
            try {
                await move();
                status.moved++;
                return;
            } catch (err) {
                lastError = err;
                if (attempt < RETRIES) await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
            }
        }
        const error = lastError instanceof Error ? lastError.message : String(lastError);
        status.failed.push({ collection, error });
        console.warn(`[Namespaces] Could not move ${collection}:`, error);
    }
}
