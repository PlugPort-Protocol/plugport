// Display logic for private collections and customers' own private stores
// (option B). Kept free of React so it can be tested directly.

export interface MigrationEstimate {
    documents: number;
    keys: number;
    transactions: number;
    estimatedSeconds: number;
    destination: string;
    historyRemainsPublic: boolean;
}

export interface StoreMigration {
    state: 'running' | 'done' | 'failed';
    store: string;
    total: number;
    moved: number;
    current?: string;
    failed: { collection: string; error: string }[];
}

export interface PrivateStoreStatus {
    enabled: boolean;
    store: { address: string; linkedAt: number } | null;
    status: 'none' | 'active' | 'detached';
    reason?: string;
    migration?: StoreMigration | null;
}

/** "about 45 s" / "about 3 min" */
export function formatDuration(seconds: number): string {
    if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} s`;
    return `about ${Math.round(seconds / 60)} min`;
}

/** What switching a collection's mode will do, shown before the user confirms. */
export function describeSwitch(collection: string, mode: 'public' | 'private', e: MigrationEstimate): string[] {
    const lines = [
        `${e.documents.toLocaleString()} document${e.documents === 1 ? '' : 's'} (${e.keys.toLocaleString()} entries with indexes) will move to the ${e.destination}.`,
        `That takes ${e.transactions.toLocaleString()} transaction${e.transactions === 1 ? '' : 's'}, ${formatDuration(e.estimatedSeconds)}. PlugPort pays the gas.`,
        `Writes to ${collection} are paused until the move finishes; reads keep working.`,
    ];
    if (mode === 'private' && e.historyRemainsPublic) {
        lines.push('Data written while it was public stays readable in the chain history. Only the live copy becomes private.');
    }
    if (mode === 'public') {
        lines.push('After this, anyone can read the collection, and everything written from now on stays public in the chain history.');
    }
    return lines;
}

/** Headline, tone and detail for the Deploy tab's store panel. */
export function storeStatusView(s: PrivateStoreStatus): { title: string; tone: 'info' | 'success' | 'error'; detail: string } {
    if (!s.enabled) {
        return { title: 'Not available on this network', tone: 'info', detail: 'Per-customer private stores are not enabled on this server. Private collections use the shared private store.' };
    }
    if (s.status === 'none' || !s.store) {
        return { title: 'No private store yet', tone: 'info', detail: 'Your private collections are in the shared private store. Deploy your own to keep them in a contract you own.' };
    }
    if (s.status === 'detached') {
        return {
            title: 'PlugPort is cut off from your store',
            tone: 'error',
            detail: `${s.reason ? `PlugPort can't use ${s.store.address}: ${s.reason}. ` : ''}Your data is still in your contract. Make PlugPort's writer the store's gas station again (transferGasStation) to restore access.`,
        };
    }
    return { title: 'Your private store is active', tone: 'success', detail: `Your private collections are stored in ${s.store.address}, a contract you own.` };
}

/** "Moving 3 of 5 collections (now: payroll)" and similar, or null when there is nothing to say. */
export function describeMigration(m: StoreMigration | null | undefined): string | null {
    if (!m || m.total === 0) return null;
    if (m.state === 'running') {
        return `Moving your private collections into your store: ${m.moved} of ${m.total} done${m.current ? ` (now: ${m.current})` : ''}.`;
    }
    if (m.state === 'failed') {
        return `Moved ${m.moved} of ${m.total} collections. Not moved: ${m.failed.map((f) => f.collection).join(', ')} (they stay in the shared store and will be retried).`;
    }
    return `All ${m.total} of your private collections are in your store.`;
}

/**
 * Whether the dashboard should offer write actions on a collection: only its
 * owner, and the operator view (no owner recorded, no wallet). The server
 * enforces this regardless; this only avoids buttons that would be refused.
 * Wallets granted write access can still write through the API.
 */
export function ownsCollection(collection: { ownerAddress?: string }, wallet: string | null | undefined): boolean {
    if (!wallet) return false;
    return !!collection.ownerAddress && collection.ownerAddress.toLowerCase() === wallet.toLowerCase();
}
