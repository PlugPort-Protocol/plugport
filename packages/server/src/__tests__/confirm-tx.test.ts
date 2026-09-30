// confirmTx replaces ethers' tx.wait(): when the RPC rate-limits a receipt
// poll, ethers' own poller leaks the error as an unhandled rejection that
// crashes the server. These tests check that confirmTx retries through RPC
// errors, still surfaces reverts, and fails with a timeout instead of hanging.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ethers } from 'ethers';
import { confirmTx } from '../storage/tx-sequencer.js';

const FAST = { pollIntervalMs: 1, maxBackoffMs: 4 };
const HASH = '0x' + 'ab'.repeat(32);

const rateLimited = () => Object.assign(new Error('could not coalesce error'), {
    code: 'UNKNOWN_ERROR',
    error: { code: -32007, message: '50/second request limit reached' },
});

function fakeTx(responses: Array<ethers.TransactionReceipt | null | Error>): {
    tx: ethers.TransactionResponse;
    calls: () => number;
} {
    let i = 0;
    const provider = {
        getTransactionReceipt: vi.fn(async () => {
            const r = responses[Math.min(i++, responses.length - 1)];
            if (r instanceof Error) throw r;
            return r;
        }),
    };
    return {
        tx: { hash: HASH, provider } as unknown as ethers.TransactionResponse,
        calls: () => provider.getTransactionReceipt.mock.calls.length,
    };
}

const receipt = (status: number) => ({ hash: HASH, status, to: '0x1', from: '0x2' }) as unknown as ethers.TransactionReceipt;

describe('confirmTx', () => {
    afterEach(() => vi.restoreAllMocks());

    it('returns the receipt once the transaction is mined', async () => {
        const { tx, calls } = fakeTx([null, null, receipt(1)]);
        await expect(confirmTx(tx, FAST)).resolves.toMatchObject({ status: 1 });
        expect(calls()).toBe(3);
    });

    it('retries through RPC rate-limit errors instead of rejecting', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { tx } = fakeTx([null, rateLimited(), rateLimited(), receipt(1)]);
        await expect(confirmTx(tx, FAST)).resolves.toMatchObject({ status: 1 });
    });

    it('rejects with CALL_EXCEPTION when the transaction reverted', async () => {
        const { tx } = fakeTx([receipt(0)]);
        await expect(confirmTx(tx, FAST)).rejects.toMatchObject({ code: 'CALL_EXCEPTION' });
    });

    it('times out, naming the last RPC error, when no receipt ever arrives', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { tx } = fakeTx([rateLimited()]);
        await expect(confirmTx(tx, { ...FAST, timeoutMs: 30 }))
            .rejects.toThrow(/not confirmed within 30ms.*could not coalesce/);
    });

    it('never produces an unhandled rejection while the RPC is failing', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const unhandled: unknown[] = [];
        const onUnhandled = (r: unknown) => unhandled.push(r);
        process.on('unhandledRejection', onUnhandled);
        try {
            const { tx } = fakeTx([rateLimited(), rateLimited(), null, receipt(1)]);
            await confirmTx(tx, FAST);
            await new Promise((r) => setTimeout(r, 10));
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });
});
