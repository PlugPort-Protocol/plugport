// On-chain key reads. The public Monad RPC intermittently fails view calls with
// "missing revert data". AuthContractAdapter used to swallow every such error
// and answer with a made-up default — getActiveKeys -> [] and getNonce -> 0 —
// so a transient hiccup showed up in the dashboard as "you have no keys"
// (and could make it sign with a wrong nonce). These tests pin the fix:
// retry transient failures, and never confuse "read failed" with "empty".

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthContractAdapter, AuthReadError } from '../auth/auth-contract.js';

const ADDR = '0x00000000000000000000000000000000000000aa';
const rpcError = () => new Error('missing revert data (action="call", data=null, code=CALL_EXCEPTION)');

const verifier = (n: number) => ({
    salt: `0xsalt${n}`, storedKey: `0xstored${n}`, serverKey: `0xserver${n}`, active: true,
});

/** An adapter with a stubbed contract — no constructor, so no network. */
function makeAdapter(contract: Record<string, unknown> | null) {
    const a = Object.create(AuthContractAdapter.prototype) as any;
    a.contractAddress = '0x0000000000000000000000000000000000000001';
    // getActiveKeys() reads the nonce alongside the keys, so default it unless a test overrides it.
    a.readContract = contract && { nonces: vi.fn(async () => 0n), ...contract };
    // These tests exercise the per-call fallback path; the Multicall3 path has
    // its own tests (auth-contract-multicall.test.ts).
    a.multicall = vi.fn(async () => { throw new Error('multicall unavailable'); });
    return a as AuthContractAdapter;
}

/** A function that fails `n` times, then returns `value`. */
const flaky = <T>(n: number, value: T) => {
    let calls = 0;
    return vi.fn(async () => {
        if (calls++ < n) throw rpcError();
        return value;
    });
};

const original = { ...AuthContractAdapter.READ_RETRY };
beforeEach(() => {
    AuthContractAdapter.READ_RETRY = { attempts: 3, baseDelayMs: 1 };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    AuthContractAdapter.READ_RETRY = original;
    vi.restoreAllMocks();
});

describe('getActiveKeys', () => {
    it('returns the keys when the chain answers', async () => {
        const a = makeAdapter({
            getActiveKeys: vi.fn(async () => [0n, 1n]),
            getCommitment: vi.fn(async (_a: string, i: number) => `0xcommit${i}`),
            getVerifier: vi.fn(async (_a: string, i: number) => verifier(i)),
        });
        const keys = await a.getActiveKeys(ADDR);
        expect(keys.map((k) => k.keyIndex)).toEqual([0, 1]);
        expect(keys[1].commitment).toBe('0xcommit1');
    });

    it('recovers from transient RPC failures instead of reporting no keys', async () => {
        const a = makeAdapter({
            getActiveKeys: flaky(2, [0n]),
            getCommitment: vi.fn(async () => '0xc'),
            getVerifier: vi.fn(async () => verifier(0)),
        });
        expect((await a.getActiveKeys(ADDR)).map((k) => k.keyIndex)).toEqual([0]);
    });

    it('one flaky per-key call no longer discards the whole list', async () => {
        const a = makeAdapter({
            getActiveKeys: vi.fn(async () => [0n, 1n, 2n]),
            getCommitment: vi.fn(async (_a: string, i: number) => `0xc${i}`),
            // key #1's verifier read fails once, then works
            getVerifier: vi.fn(async (_a: string, i: number) => {
                if (i === 1 && (a as any).__failedOnce !== true) { (a as any).__failedOnce = true; throw rpcError(); }
                return verifier(i);
            }),
        });
        const keys = await a.getActiveKeys(ADDR);
        expect(keys.map((k) => k.keyIndex)).toEqual([0, 1, 2]);
    });

    it('THROWS when the read keeps failing — never an empty list', async () => {
        const a = makeAdapter({
            getActiveKeys: vi.fn(async () => { throw rpcError(); }),
            getCommitment: vi.fn(),
            getVerifier: vi.fn(),
        });
        await expect(a.getActiveKeys(ADDR)).rejects.toBeInstanceOf(AuthReadError);
    });

    it('a genuinely empty result is still an empty list (not an error)', async () => {
        const a = makeAdapter({ getActiveKeys: vi.fn(async () => []), getCommitment: vi.fn(), getVerifier: vi.fn() });
        expect(await a.getActiveKeys(ADDR)).toEqual([]);
    });

    it('returns [] when the adapter is not configured (nothing to read)', async () => {
        expect(await makeAdapter(null).getActiveKeys(ADDR)).toEqual([]);
    });
});

describe('getNonce', () => {
    it('reads the nonce', async () => {
        expect(await makeAdapter({ nonces: vi.fn(async () => 25n) }).getNonce(ADDR)).toBe(25);
    });

    it('recovers from a transient failure', async () => {
        expect(await makeAdapter({ nonces: flaky(2, 7n) }).getNonce(ADDR)).toBe(7);
    });

    it('THROWS on persistent failure instead of answering 0', async () => {
        const a = makeAdapter({ nonces: vi.fn(async () => { throw rpcError(); }) });
        await expect(a.getNonce(ADDR)).rejects.toBeInstanceOf(AuthReadError);
    });
});

describe('fail-closed reads used for authentication', () => {
    it('getVerifier retries, then returns null (deny) rather than throwing', async () => {
        expect(await makeAdapter({ getVerifier: flaky(1, verifier(0)) }).getVerifier(ADDR, 0)).toMatchObject({ storedKey: '0xstored0' });
        const dead = makeAdapter({ getVerifier: vi.fn(async () => { throw rpcError(); }) });
        expect(await dead.getVerifier(ADDR, 0)).toBeNull();
    });

    it('validateKey retries, then denies', async () => {
        expect(await makeAdapter({ validateKey: flaky(1, true) }).validateKey(ADDR, '0xh')).toBe(true);
        expect(await makeAdapter({ validateKey: vi.fn(async () => { throw rpcError(); }) }).validateKey(ADDR, '0xh')).toBe(false);
    });
});
