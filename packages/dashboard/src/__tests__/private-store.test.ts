// What the dashboard tells customers about private collections and their own
// private stores. The wording matters: it is the warning the server requires
// before a privacy switch, and the instructions when a store is cut off.

import { describe, it, expect } from 'vitest';
import { describeSwitch, storeStatusView, describeMigration, ownsCollection, formatDuration, type MigrationEstimate } from '../lib/private-store';

const estimate: MigrationEstimate = { documents: 2, keys: 4, transactions: 1, estimatedSeconds: 3, destination: 'shared private store', historyRemainsPublic: true };

describe('describeSwitch', () => {
    it('says what moves, what it costs, and that public history stays public', () => {
        const lines = describeSwitch('orders', 'private', estimate).join(' ');
        expect(lines).toContain('2 documents (4 entries with indexes) will move to the shared private store');
        expect(lines).toContain('1 transaction, about 3 s');
        expect(lines).toContain('Writes to orders are paused');
        expect(lines).toContain('stays readable in the chain history');
    });

    it('warns that going public is permanent from then on', () => {
        expect(describeSwitch('orders', 'public', { ...estimate, historyRemainsPublic: false }).join(' ')).toMatch(/anyone can read the collection/);
    });

    it('formats durations', () => {
        expect(formatDuration(3)).toBe('about 3 s');
        expect(formatDuration(600)).toBe('about 10 min');
    });
});

describe('storeStatusView', () => {
    const store = { address: '0xD2EE5C9f3940520623621226C14EACEf29Ba0aC9', linkedAt: 0 };
    it('covers every state, including how to recover a cut-off store', () => {
        expect(storeStatusView({ enabled: false, store: null, status: 'none' }).title).toBe('Not available on this network');
        expect(storeStatusView({ enabled: true, store: null, status: 'none' }).tone).toBe('info');
        expect(storeStatusView({ enabled: true, store, status: 'active' })).toMatchObject({ tone: 'success', detail: expect.stringContaining(store.address) });
        const detached = storeStatusView({ enabled: true, store, status: 'detached', reason: "its owner has revoked PlugPort's writer" });
        expect(detached.tone).toBe('error');
        expect(detached.detail).toContain('Your data is still in your contract');
        expect(detached.detail).toContain('transferGasStation');
    });
});

describe('describeMigration', () => {
    it('reports progress, partial failure and completion', () => {
        expect(describeMigration(null)).toBeNull();
        expect(describeMigration({ state: 'running', store: '0x1', total: 5, moved: 2, current: 'payroll', failed: [] })).toBe('Moving your private collections into your store: 2 of 5 done (now: payroll).');
        expect(describeMigration({ state: 'failed', store: '0x1', total: 2, moved: 1, failed: [{ collection: 'big', error: 'x' }] })).toMatch(/Not moved: big/);
        expect(describeMigration({ state: 'done', store: '0x1', total: 2, moved: 2, failed: [] })).toBe('All 2 of your private collections are in your store.');
    });
});

describe('ownsCollection', () => {
    it('is true only for the owner wallet, case-insensitively', () => {
        expect(ownsCollection({ ownerAddress: '0xabc' }, '0xABC')).toBe(true);
        expect(ownsCollection({ ownerAddress: '0xabc' }, '0xdef')).toBe(false);
        expect(ownsCollection({}, '0xabc')).toBe(false);
        expect(ownsCollection({ ownerAddress: '0xabc' }, null)).toBe(false);
    });
});
