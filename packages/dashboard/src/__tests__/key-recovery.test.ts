// Regression tests for "Recover Keys created 7 phantom keys": recovery must only
// ever show keys the chain holds, and must not ask for more signatures than needed.

import { describe, it, expect, vi } from 'vitest';
import { recoverKeys, recoverOne, type ChainKey } from '../lib/key-recovery';

// Stand-ins: derive(i) -> "key-i", commitment = "c(" + key + ")".
const derive = (i: number) => Promise.resolve(`key-${i}`);
const commitmentOf = (k: string) => `c(${k})`;
const chain = (...pairs: [number, number][]): ChainKey[] =>
    pairs.map(([slot, derivedFrom]) => ({ keyIndex: slot, commitment: `c(key-${derivedFrom})`, active: true, createdAt: 0 }));

describe('recoverKeys', () => {
    it('returns exactly the keys on-chain — 3 registered keys never become 10', async () => {
        const res = await recoverKeys({ chainKeys: chain([0, 0], [1, 1], [2, 2]), derive, commitmentOf, maxScan: 10 });
        expect(res.keys).toHaveLength(3);
        expect(res.keys.map(k => k.keyIndex)).toEqual([0, 1, 2]);
        expect(res.keys.every(k => k.derivedKey)).toBe(true);
        expect(res).toMatchObject({ recovered: 3, total: 3, interrupted: false });
    });

    it('stops asking for signatures as soon as every key is matched', async () => {
        const d = vi.fn(derive);
        await recoverKeys({ chainKeys: chain([0, 0], [1, 1], [2, 2]), derive: d, commitmentOf, maxScan: 10 });
        expect(d).toHaveBeenCalledTimes(3); // not 10
    });

    it('matches by commitment, not by slot — slot and derivation index may differ (older keys)', async () => {
        // slot 0 holds the key derived from index 4; slot 1 the one from index 2
        const res = await recoverKeys({ chainKeys: chain([0, 4], [1, 2]), derive, commitmentOf, maxScan: 10 });
        expect(res.keys.map(k => k.derivedKey)).toEqual(['key-4', 'key-2']);
    });

    it('reports a key that cannot be re-derived, without inventing one', async () => {
        const foreign: ChainKey = { keyIndex: 5, commitment: 'c(not-from-this-wallet)', active: true, createdAt: 0 };
        const res = await recoverKeys({ chainKeys: [...chain([0, 0]), foreign], derive, commitmentOf, maxScan: 10 });
        expect(res.keys.find(k => k.keyIndex === 5)?.derivedKey).toBeUndefined();
        expect(res).toMatchObject({ recovered: 1, total: 2 });
    });

    it('handles duplicate commitments (same key registered in two slots)', async () => {
        const res = await recoverKeys({ chainKeys: chain([0, 0], [5, 0]), derive, commitmentOf, maxScan: 10 });
        expect(res.keys.map(k => k.derivedKey)).toEqual(['key-0', 'key-0']);
    });

    it('a rejected signature keeps what was matched and flags the run as interrupted', async () => {
        const d = vi.fn(async (i: number) => { if (i === 1) throw new Error('User rejected'); return `key-${i}`; });
        const res = await recoverKeys({ chainKeys: chain([0, 0], [1, 1], [2, 2]), derive: d, commitmentOf, maxScan: 10 });
        expect(res.keys).toHaveLength(3);
        expect(res.recovered).toBe(1);
        expect(res.interrupted).toBe(true);
    });

    it('no keys on-chain means nothing to recover and no signatures requested', async () => {
        const d = vi.fn(derive);
        const res = await recoverKeys({ chainKeys: [], derive: d, commitmentOf, maxScan: 10 });
        expect(res).toMatchObject({ keys: [], recovered: 0, total: 0, interrupted: false });
        expect(d).not.toHaveBeenCalled();
    });

    it('never scans past maxScan', async () => {
        const d = vi.fn(derive);
        await recoverKeys({ chainKeys: chain([0, 99]), derive: d, commitmentOf, maxScan: 4 });
        expect(d).toHaveBeenCalledTimes(4);
    });
});

describe('recoverOne', () => {
    const one = (k: ChainKey, d = derive, maxScan = 10) => recoverOne({ chainKey: k, derive: d, commitmentOf, maxScan });

    it('takes a single signature when the slot index is the derivation index', async () => {
        const d = vi.fn(derive);
        const res = await one(chain([3, 3])[0], d);
        expect(res).toMatchObject({ derivedKey: 'key-3', attempts: 1, interrupted: false });
        expect(d).toHaveBeenCalledTimes(1);
        expect(d).toHaveBeenCalledWith(3);
    });

    it('falls back to the other indexes for older keys whose slot differs', async () => {
        const res = await one(chain([1, 6])[0]);
        expect(res.derivedKey).toBe('key-6');
        expect(res.attempts).toBe(7); // slot 1 first, then 0,2,3,4,5,6
    });

    it('never signs the same index twice', async () => {
        const seen: number[] = [];
        await one(chain([2, 99])[0], async (i) => { seen.push(i); return `key-${i}`; }, 5);
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen).toHaveLength(5);
    });

    it('gives up cleanly when nothing matches', async () => {
        const res = await one({ keyIndex: 0, commitment: 'c(foreign)', active: true, createdAt: 0 });
        expect(res.derivedKey).toBeUndefined();
        expect(res.interrupted).toBe(false);
    });

    it('a rejected signature stops immediately and is reported as interrupted', async () => {
        const d = vi.fn(async () => { throw new Error('User rejected'); });
        const res = await one(chain([0, 0])[0], d);
        expect(res).toMatchObject({ interrupted: true, attempts: 1 });
        expect(d).toHaveBeenCalledTimes(1);
    });
});
