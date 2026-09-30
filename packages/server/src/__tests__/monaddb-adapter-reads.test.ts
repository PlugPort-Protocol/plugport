// After a restart nothing is cached, and every concurrent dashboard poll scans the
// same meta keys — each used to cost its own RPC round trip, enough to hit the
// provider's 50 requests/second limit (2026-09-28). Concurrent reads of one key
// now share a round trip; these tests pin that down, and that a write landing
// while such a read is in flight is not overwritten by the older value.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../storage/tx-sequencer.js', () => ({
    sendContractTx: vi.fn(async () => ({})),
    confirmTx: vi.fn(async () => ({})),
}));

import { MonadAdapter } from '../storage/monaddb-adapter.js';

function setup() {
    vi.spyOn(console, 'log').mockImplementation(() => { });
    vi.spyOn(console, 'warn').mockImplementation(() => { });
    const adapter = new MonadAdapter({
        rpcUrl: 'http://127.0.0.1:1',
        chainId: 10143,
        privateKey: 'a'.repeat(64),
        contractAddress: '0x' + '1'.repeat(40),
    });
    const contract = {
        exists: vi.fn(async () => true),
        get: vi.fn(async () => '0x68656c6c6f'), // "hello"
        put: { populateTransaction: vi.fn(async () => ({})) },
    };
    Object.assign(adapter as any, { contract, indexLoadPromise: Promise.resolve() });
    return { adapter, contract };
}

describe('MonadAdapter concurrent reads of one key', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('share a single RPC round trip', async () => {
        const { adapter, contract } = setup();

        const results = await Promise.all(Array.from({ length: 10 }, () => adapter.get('meta:collection:users')));
        expect(results.every((r) => r?.toString() === 'hello')).toBe(true);
        expect(contract.exists).toHaveBeenCalledTimes(1);
        expect(contract.get).toHaveBeenCalledTimes(1);

        // And the value is cached afterwards.
        await adapter.get('meta:collection:users');
        expect(contract.get).toHaveBeenCalledTimes(1);
    });

    it('share a miss too, without caching it', async () => {
        const { adapter, contract } = setup();
        contract.exists.mockResolvedValue(false);

        const results = await Promise.all(Array.from({ length: 5 }, () => adapter.get('meta:privacy:unowned')));
        expect(results).toEqual([null, null, null, null, null]);
        expect(contract.exists).toHaveBeenCalledTimes(1);

        await adapter.get('meta:privacy:unowned');
        expect(contract.exists).toHaveBeenCalledTimes(2);
    });

    it('do not overwrite a value written while the read was in flight', async () => {
        const { adapter, contract } = setup();
        let releaseRead: (() => void) | undefined;
        contract.exists.mockImplementation(() => new Promise<boolean>((r) => { releaseRead = () => r(true); }));
        contract.get.mockResolvedValue('0x6f6c64'); // "old"

        const staleRead = adapter.get('k');
        await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
        await adapter.put('k', Buffer.from('new'));
        releaseRead!();
        expect((await staleRead)?.toString()).toBe('old');

        expect((await adapter.get('k'))?.toString()).toBe('new');
    });
});
