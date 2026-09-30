// Process-wide transaction sequencer for gas-station wallets.
//
// Several subsystems (the document store, on-chain auth, the pub/sub broker)
// each build their own ethers.Wallet around the SAME gas-station key. Left to
// themselves, each fetches "the next nonce" from the RPC independently, so two
// sends that land close together can pick the same nonce — or pick one that a
// lagging RPC node reports as stale — and one of them is rejected with
// "An existing transaction had higher priority" / "nonce too low".
//
// Every send from such a wallet goes through sendSequenced() instead. It keys
// a lock and a local nonce counter by wallet ADDRESS (not by Wallet object),
// so all subsystems sharing a key share one queue:
//   - the lock covers nonce assignment + signing + broadcast only. Gas
//     estimation happens BEFORE taking it (in sendContractTx) and confirmation
//     happens after releasing it (confirmTx), so transactions still pipeline into
//     consecutive blocks and slow RPC lookups never queue other senders;
//   - the local counter never moves backwards, so a lagging RPC "pending"
//     count can't hand out a nonce we've already used;
//   - the chain's own count is still consulted each time (max of the two),
//     so an external sender advancing the account is picked up too;
//   - nonce-class rejections resync from the chain and retry.

import { makeError, type ethers } from 'ethers';
import { emitTxFailed } from './chain-events.js';

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_SEND_TIMEOUT_MS = 45_000;
/** Within this window after a send, our own counter is authoritative. */
const LOCAL_TRUST_MS = 10_000;

export interface SequencerOptions {
    maxAttempts?: number;
    retryDelayMs?: number;
    timeoutMs?: number;
}

class AsyncLock {
    private tail: Promise<void> = Promise.resolve();

    async run<T>(fn: () => Promise<T>): Promise<T> {
        const prev = this.tail;
        let release!: () => void;
        this.tail = new Promise<void>((resolve) => { release = resolve; });
        await prev;
        try {
            return await fn();
        } finally {
            release();
        }
    }
}

interface WalletState {
    lock: AsyncLock;
    /** Next nonce we expect to use; null until first send or after a reset. */
    nextNonce: number | null;
    lastSendAt: number;
}

const states = new Map<string, WalletState>();

function getState(address: string): WalletState {
    const key = address.toLowerCase();
    let state = states.get(key);
    if (!state) {
        state = { lock: new AsyncLock(), nextNonce: null, lastSendAt: 0 };
        states.set(key, state);
    }
    return state;
}

/** Errors that mean "the nonce we used is stale or already occupied". */
export function isNonceError(err: unknown): boolean {
    const text = err instanceof Error ? `${err.message} ${(err as { code?: string }).code ?? ''}` : String(err);
    return /higher priority|nonce too low|nonce has already been used|already known|replacement transaction underpriced|NONCE_EXPIRED|REPLACEMENT_UNDERPRICED/i.test(text);
}

async function chainNonce(signer: ethers.Signer, address: string): Promise<number> {
    const provider = signer.provider;
    if (!provider) throw new Error('tx-sequencer: signer has no provider');
    const [latest, pending] = await Promise.all([
        provider.getTransactionCount(address, 'latest'),
        provider.getTransactionCount(address, 'pending'),
    ]);
    return Math.max(latest, pending);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`tx-sequencer: send timed out after ${ms}ms`)), ms);
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Broadcast a transaction from `signer` with a coordinated nonce.
 * `send` must pass the given nonce through to the underlying call, e.g.
 * `(nonce) => contract.put(hash, value, { nonce })`. Resolves as soon as the
 * transaction is accepted by the RPC; the caller awaits `confirmTx(tx)` itself.
 */
export async function sendSequenced<T>(
    signer: ethers.Signer,
    send: (nonce: number) => Promise<T>,
    opts: SequencerOptions = {},
): Promise<T> {
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;

    const address = await signer.getAddress();
    const state = getState(address);

    return state.lock.run(async () => {
        let floor = 0; // lowest nonce we're willing to try after a nonce error
        let lastErr: unknown;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            // During a burst our own counter is authoritative, so skip the RPC
            // round trip. After idling (or any nonce error) re-read the chain so
            // an external sender or a lagging node can't leave us behind.
            const trustLocal = state.nextNonce !== null && Date.now() - state.lastSendAt < LOCAL_TRUST_MS;
            const onChain = trustLocal ? 0 : await chainNonce(signer, address);
            const nonce = Math.max(state.nextNonce ?? 0, onChain, floor);

            try {
                const result = await withTimeout(send(nonce), timeoutMs);
                state.nextNonce = nonce + 1;
                state.lastSendAt = Date.now();
                return result;
            } catch (err) {
                lastErr = err;
                if (!isNonceError(err)) {
                    // A revert / bad request never consumed a nonce.
                    throw err;
                }
                // Something already occupies this nonce (or the RPC's view was
                // stale). Never retry at or below it.
                floor = nonce + 1;
                state.nextNonce = null;
                if (attempt < maxAttempts) {
                    console.warn(`[TxSequencer] nonce ${nonce} rejected for ${address} (attempt ${attempt}/${maxAttempts}) — resyncing`);
                    await sleep(retryDelayMs * attempt);
                }
            }
        }
        throw lastErr;
    });
}

/**
 * Send a contract call from `signer` with a coordinated nonce.
 *
 * `populate` builds the unsigned call, e.g.
 * `() => contract.put.populateTransaction(hash, value)`. Gas and fees are
 * estimated up front, outside the lock, so concurrent callers estimate in
 * parallel and a reverting call fails without ever holding the queue. Only the
 * final nonce-assign + sign + broadcast is serialized. Resolves once the RPC
 * accepts the transaction; the caller awaits `confirmTx(tx)` itself.
 */
export async function sendContractTx(
    signer: ethers.Signer,
    populate: () => Promise<ethers.ContractTransaction>,
    opts: SequencerOptions = {},
): Promise<ethers.TransactionResponse> {
    try {
        const base = await populate();
        // A placeholder nonce stops populateTransaction from fetching one we'd
        // discard anyway; the real one is assigned inside the lock.
        const prepared = await signer.populateTransaction({ ...base, nonce: 0 });
        delete (prepared as { from?: unknown }).from;
        return await sendSequenced(signer, (nonce) => signer.sendTransaction({ ...prepared, nonce }), opts);
    } catch (err) {
        emitTxFailed('send', err);
        throw err;
    }
}

export interface ConfirmOptions {
    /** Give up after this long without a receipt. */
    timeoutMs?: number;
    /** Delay between receipt polls while the RPC is healthy. */
    pollIntervalMs?: number;
    /** Upper bound for the backoff applied after failed polls. */
    maxBackoffMs?: number;
}

const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 8_000;

/**
 * Wait for `tx` to be mined and return its receipt. Use this instead of
 * `tx.wait()`.
 *
 * When the first receipt lookup comes back empty, ethers' `wait()` keeps
 * polling from a per-block subscriber that never catches its own errors
 * (ethers 6.16 `OnBlockSubscriber`). A single failed poll — e.g. the RPC's
 * "50/second request limit reached" — then becomes an unhandled rejection
 * that no caller can catch, and it kills the process. This polls the
 * receipt directly instead: RPC errors back off and retry, and only a
 * revert or the timeout rejects, into the caller's own `await`.
 */
export async function confirmTx(
    tx: ethers.TransactionResponse,
    opts: ConfirmOptions = {},
): Promise<ethers.TransactionReceipt> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const deadline = Date.now() + timeoutMs;

    let delay = pollIntervalMs;
    let lastErr: unknown;
    for (;;) {
        try {
            const receipt = await tx.provider.getTransactionReceipt(tx.hash);
            if (receipt) {
                if (receipt.status === 0) {
                    throw makeError('transaction execution reverted', 'CALL_EXCEPTION', {
                        action: 'sendTransaction',
                        data: null, reason: null, invocation: null, revert: null,
                        transaction: { to: receipt.to, from: receipt.from, data: '' },
                        receipt,
                    });
                }
                return receipt;
            }
            delay = pollIntervalMs;
        } catch (err) {
            if ((err as { code?: string }).code === 'CALL_EXCEPTION') {
                emitTxFailed('confirm', err);
                throw err;
            }
            lastErr = err;
            delay = Math.min(delay * 2, maxBackoffMs);
            console.warn(`[TxSequencer] receipt poll for ${tx.hash} failed — retrying in ${delay}ms:`,
                err instanceof Error ? err.message.slice(0, 200) : err);
        }
        if (Date.now() + delay > deadline) {
            const detail = lastErr instanceof Error ? ` (last RPC error: ${lastErr.message.slice(0, 200)})` : '';
            const timeout = new Error(`Transaction ${tx.hash} was not confirmed within ${timeoutMs}ms${detail}`);
            emitTxFailed('confirm', timeout);
            throw timeout;
        }
        await sleep(delay);
    }
}

/** Test hook: forget all per-wallet state. */
export function _resetTxSequencer(): void {
    states.clear();
}
