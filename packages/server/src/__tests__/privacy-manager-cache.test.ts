// Privacy lookups run on every /api/v1/collections call (the dashboard polls every
// 5s). Most collections have no privacy record, and on the Monad adapter a missing
// key is never cached, so each poll re-read every unowned collection from the chain.

import { describe, it, expect, vi } from 'vitest';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { PrivacyManager } from '../storage/privacy-manager.js';

const ME = '0xb2ac1908cfb52debcca860ebcf538770e67df2b5';

describe('PrivacyManager cache', () => {
    it('remembers that a collection has no privacy settings', async () => {
        const kv = new InMemoryKVStore();
        const get = vi.spyOn(kv, 'get');
        const pm = new PrivacyManager(kv);

        expect(await pm.getCollectionPrivacy('unowned')).toBeNull();
        expect(await pm.getCollectionPrivacy('unowned')).toBeNull();
        expect(await pm.hasReadAccess('unowned', ME)).toBe(true);
        expect(get).toHaveBeenCalledTimes(1);
    });

    it('sees a claim made after "no settings" was cached', async () => {
        const pm = new PrivacyManager(new InMemoryKVStore());
        expect(await pm.getCollectionPrivacy('fresh')).toBeNull();

        expect(await pm.claimIfUnowned('fresh', ME)).toBe(true);
        expect((await pm.getCollectionPrivacy('fresh'))?.ownerAddress).toBe(ME);
    });

    it('re-reads "no settings" once the cache entry expires', async () => {
        vi.useFakeTimers();
        try {
            const kv = new InMemoryKVStore();
            const get = vi.spyOn(kv, 'get');
            const pm = new PrivacyManager(kv);
            await pm.getCollectionPrivacy('unowned');
            vi.advanceTimersByTime(31_000);
            await pm.getCollectionPrivacy('unowned');
            expect(get).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });
});
