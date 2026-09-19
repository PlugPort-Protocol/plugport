// The gas-station wallet is shared by several subsystems that each build
// their own ethers.Wallet around the same key. Without coordination they pick
// nonces independently and collide ("An existing transaction had higher
// priority"). These tests run against a simulated chain whose RPC has real
// latency and can report stale counts, so uncoordinated sends actually race.

import { describe, it, expect, beforeEach } from 'vitest';
import type { ethers } from 'ethers';
import { sendSequenced, sendContractTx, isNonceError, _resetTxSequencer } from '../storage/tx-sequencer.js';

const FAST = { retryDelayMs: 1 };

interface FakeChain {
    /** nonces broadcast successfully, in arrival order */
    accepted: number[];
    /** nonce the network considers next (confirmed + pending) */
    next: number;
    /** if set, getTransactionCount reports this instead of the truth (lagging node) */
    staleCount: number | null;
    /** if set, the lagging node catches up after this many getTransactionCount calls */
    staleForCalls: number | null;
    countCalls: number;
}

function makeChain(start = 0): FakeChain {
    return { accepted: [], next: start, staleCount: null, staleForCalls: null, countCalls: 0 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Signer-like object. Distinct objects can share one address, like the real subsystems. */
function fakeSigner(address: string, chain: FakeChain): ethers.Signer {
    return {
        getAddress: async () => address,
        provider: {
            getTransactionCount: async () => {
                chain.countCalls++;
                await sleep(2);
                const caughtUp = chain.staleForCalls !== null && chain.countCalls > chain.staleForCalls;
                return chain.staleCount !== null && !caughtUp ? chain.staleCount : chain.next;
            },
        },
    } as unknown as ethers.Signer;
}

/** Simulated broadcast: takes time, rejects a nonce the network already has. */
function broadcaster(chain: FakeChain, latencyMs = 5) {
    return async (nonce: number) => {
        await sleep(latencyMs);
        if (nonce < chain.next) {
            throw new Error('could not coalesce error (error={ "code": -32000, "message": "An existing transaction had higher priority" })');
        }
        chain.accepted.push(nonce);
        chain.next = nonce + 1;
        return { hash: `0x${nonce}` };
    };
}

beforeEach(() => _resetTxSequencer());

describe('sendSequenced', () => {
    it('gives 40 concurrent sends from separate wallet objects on one address 40 distinct sequential nonces', async () => {
        const chain = makeChain(100);
        const a = fakeSigner('0xAAAA', chain);
        const b = fakeSigner('0xaaaa', chain); // same address, different object, different case
        const send = broadcaster(chain);

        await Promise.all(
            Array.from({ length: 40 }, (_, i) => sendSequenced(i % 2 ? a : b, send, FAST)),
        );

        expect(chain.accepted).toHaveLength(40);
        expect(new Set(chain.accepted).size).toBe(40);
        expect(chain.accepted).toEqual(Array.from({ length: 40 }, (_, i) => 100 + i));
    });

    it('never hands out a nonce it already used when the RPC reports a stale count', async () => {
        const chain = makeChain(50);
        const signer = fakeSigner('0xBBBB', chain);
        const inner = broadcaster(chain);
        let broadcasts = 0;
        const send = (nonce: number) => { broadcasts++; return inner(nonce); };

        await sendSequenced(signer, send, FAST); // nonce 50
        chain.staleCount = 50; // lagging node keeps saying "50" even though 50 is taken

        await sendSequenced(signer, send, FAST);
        await sendSequenced(signer, send, FAST);

        expect(chain.accepted).toEqual([50, 51, 52]);
        // The local counter avoids the collision outright — not by bouncing
        // off a rejection and retrying.
        expect(broadcasts).toBe(3);
    });

    it('picks up an external sender advancing the account', async () => {
        const chain = makeChain(10);
        const signer = fakeSigner('0xCCCC', chain);
        const send = broadcaster(chain);

        await sendSequenced(signer, send, FAST); // 10
        chain.next = 25; // something else sent 14 transactions from this key

        await sendSequenced(signer, send, FAST);
        expect(chain.accepted).toEqual([10, 25]);
    });

    it('recovers from a stale-nonce rejection by resyncing and retrying', async () => {
        const chain = makeChain(200);
        const signer = fakeSigner('0xDDDD', chain);
        chain.staleCount = 170; // this node's view is 30 behind, as seen live
        chain.staleForCalls = 2; // ...and catches up after the first attempt's lookups

        const attempts: number[] = [];
        const send = async (nonce: number) => {
            attempts.push(nonce);
            return broadcaster(chain)(nonce);
        };

        await sendSequenced(signer, async (n) => {
            const res = await send(n);
            return res;
        }, FAST);

        // first attempt used the stale 170 and was rejected; the retry resynced to 200
        expect(attempts[0]).toBe(170);
        expect(attempts.length).toBeGreaterThan(1);
        expect(chain.accepted).toEqual([200]);
    });

    it('does not retry, and does not burn a nonce, on a non-nonce failure like a revert', async () => {
        const chain = makeChain(5);
        const signer = fakeSigner('0xEEEE', chain);
        let calls = 0;

        await expect(
            sendSequenced(signer, async () => {
                calls++;
                throw new Error('execution reverted: "PlugPortAuth: invalid nonce"');
            }, FAST),
        ).rejects.toThrow('invalid nonce');
        expect(calls).toBe(1);

        await sendSequenced(signer, broadcaster(chain), FAST);
        expect(chain.accepted).toEqual([5]); // the failed call didn't consume 5
    });

    it('gives up with the last error after maxAttempts', async () => {
        const chain = makeChain(0);
        const signer = fakeSigner('0xFFFF', chain);
        let calls = 0;

        await expect(
            sendSequenced(signer, async () => {
                calls++;
                throw new Error('An existing transaction had higher priority');
            }, { ...FAST, maxAttempts: 3 }),
        ).rejects.toThrow('higher priority');
        expect(calls).toBe(3);
    });

    it('does not let a stuck send on one address block another address', async () => {
        const chainA = makeChain(0);
        const chainB = makeChain(0);
        const a = fakeSigner('0x1111', chainA);
        const b = fakeSigner('0x2222', chainB);

        let releaseA!: () => void;
        const stuck = new Promise<void>((r) => { releaseA = r; });
        const aSend = sendSequenced(a, async (n) => { await stuck; return { n }; }, FAST);

        await sendSequenced(b, broadcaster(chainB), FAST);
        expect(chainB.accepted).toEqual([0]);

        releaseA();
        await aSend;
    });

    it('releases the lock after a failure so later sends still run', async () => {
        const chain = makeChain(0);
        const signer = fakeSigner('0x3333', chain);

        await expect(sendSequenced(signer, async () => { throw new Error('boom'); }, FAST)).rejects.toThrow('boom');
        await sendSequenced(signer, broadcaster(chain), FAST);
        expect(chain.accepted).toEqual([0]);
    });

    it('times out a hung send instead of wedging the queue', async () => {
        const chain = makeChain(0);
        const signer = fakeSigner('0x4444', chain);

        await expect(
            sendSequenced(signer, () => new Promise(() => { /* never resolves */ }), { ...FAST, timeoutMs: 30 }),
        ).rejects.toThrow('timed out');

        await sendSequenced(signer, broadcaster(chain), FAST);
        expect(chain.accepted).toEqual([0]);
    });
});

describe('sendContractTx', () => {
    /** Signer whose populate/send phases are observable. */
    function phasedSigner(address: string, chain: FakeChain, stats: { populating: number; maxPopulating: number; sending: number; maxSending: number; sentNonces: number[] }) {
        const base = fakeSigner(address, chain) as unknown as Record<string, unknown>;
        return {
            ...base,
            populateTransaction: async (tx: Record<string, unknown>) => {
                stats.populating++;
                stats.maxPopulating = Math.max(stats.maxPopulating, stats.populating);
                await sleep(30); // stands in for estimateGas + fee lookup
                stats.populating--;
                return { ...tx, gasLimit: 21000n };
            },
            sendTransaction: async (tx: { nonce: number }) => {
                stats.sending++;
                stats.maxSending = Math.max(stats.maxSending, stats.sending);
                try {
                    await broadcaster(chain, 8)(tx.nonce);
                    stats.sentNonces.push(tx.nonce);
                    return { hash: `0x${tx.nonce}` };
                } finally {
                    stats.sending--;
                }
            },
        } as unknown as ethers.Signer;
    }

    const freshStats = () => ({ populating: 0, maxPopulating: 0, sending: 0, maxSending: 0, sentNonces: [] as number[] });

    it('estimates gas in parallel but broadcasts strictly one at a time, with sequential nonces', async () => {
        const chain = makeChain(300);
        const stats = freshStats();
        const signer = phasedSigner('0x5555', chain, stats);

        await Promise.all(
            Array.from({ length: 8 }, () => sendContractTx(signer, async () => ({ to: '0xabc', data: '0x' }) as ethers.ContractTransaction, FAST)),
        );

        expect(stats.maxPopulating).toBeGreaterThan(1); // estimation overlapped
        expect(stats.maxSending).toBe(1); // broadcast never overlapped
        expect(stats.sentNonces).toEqual(Array.from({ length: 8 }, (_, i) => 300 + i));
    });

    it('a call that reverts while being built never enters the queue or consumes a nonce', async () => {
        const chain = makeChain(7);
        const stats = freshStats();
        const signer = phasedSigner('0x6666', chain, stats);

        await expect(
            sendContractTx(signer, async () => { throw new Error('execution reverted: "PlugPortAuth: invalid nonce"'); }, FAST),
        ).rejects.toThrow('invalid nonce');
        expect(stats.sentNonces).toEqual([]);

        await sendContractTx(signer, async () => ({ to: '0xabc', data: '0x' }) as ethers.ContractTransaction, FAST);
        expect(stats.sentNonces).toEqual([7]);
    });
});

describe('isNonceError', () => {
    it('recognizes the RPC wordings seen in production', () => {
        expect(isNonceError(new Error('An existing transaction had higher priority'))).toBe(true);
        expect(isNonceError(new Error('nonce too low'))).toBe(true);
        expect(isNonceError(new Error('nonce has already been used'))).toBe(true);
        expect(isNonceError(new Error('replacement transaction underpriced'))).toBe(true);
    });

    it('does not treat contract reverts as nonce errors', () => {
        expect(isNonceError(new Error('execution reverted: "PlugPortAuth: invalid nonce"'))).toBe(false);
        expect(isNonceError(new Error('insufficient funds'))).toBe(false);
    });
});
