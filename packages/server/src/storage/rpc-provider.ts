// JSON-RPC provider construction for the Monad RPC.
//
// ethers' JsonRpcProvider batches calls that are made close together into a
// single JSON-RPC array request. Measured against testnet-rpc.monad.xyz:
//
//   ethers default (batching), 25 concurrent reads   77 of 100 failed
//   ethers with batchMaxCount: 1, 25 concurrent        0 of 100 failed
//   raw JSON-RPC batches of 2 / 5 / 10              ~1 of every 8 / 20 / 20 calls succeeded
//   raw parallel (unbatched) requests, 25 at once   13 of 25 succeeded
//   raw sequential requests                         10 of 10 succeeded (~280 ms each)
//
// The failures surface as "missing revert data" (CALL_EXCEPTION) even though
// the contract call is fine — which is why reads looked randomly flaky and a
// wallet's key list could come back empty. With batchMaxCount: 1 ethers sends
// one request per call.
//
// Rate limit: Monad's public testnet RPC is served by QuickNode and capped at
// 50 requests/second. Going over returns -32007 ("upgrade your account" is
// QuickNode's stock wording — there is no account of ours behind it), and on
// 2026-09-28 a post-restart burst (key-registry replay running alongside the
// dashboard's first polls) hit it three times in six minutes. Every provider
// built here shares one process-wide limiter, so the server as a whole stays
// under RPC_MAX_REQUESTS_PER_SECOND (default 40, leaving headroom for the
// WebSocket subscription, which does not go through here).
//
// Fallback: when MONAD_RPC_FALLBACK_URL is set, a call the primary endpoint
// rejects for endpoint reasons (rate limit, HTTP 429/5xx, timeout, network
// error) is re-sent there, and every provider routes straight to the fallback
// for a cooldown before trying the primary again. Contract reverts and other
// genuine errors are returned as-is — they would fail on any endpoint. The
// fallback has its own limiter (RPC_FALLBACK_MAX_REQUESTS_PER_SECOND).

import { ethers } from 'ethers';
import { emitRpcFailover } from './chain-events.js';

const DEFAULT_MAX_REQUESTS_PER_SECOND = 40;
// Alchemy's free tier budgets compute units per second rather than requests;
// an eth_call costs ~26 CU, so this stays well inside it.
const DEFAULT_FALLBACK_MAX_REQUESTS_PER_SECOND = 10;

/**
 * Spaces requests evenly — at most `perSecond` start in any one second, with no
 * burst allowance, because the provider's limit is counted per second and a
 * burst at a window boundary would exceed it. FIFO: callers are released in
 * the order they asked.
 */
export class RpcRateLimiter {
    private nextSlot = 0;
    private readonly intervalMs: number;

    constructor(perSecond: number) {
        if (!(perSecond > 0)) throw new Error(`RPC rate limit must be positive, got ${perSecond}`);
        this.intervalMs = 1000 / perSecond;
    }

    /** Resolves when `cost` requests may be sent. */
    async acquire(cost = 1): Promise<void> {
        const now = Date.now();
        const start = Math.max(now, this.nextSlot);
        this.nextSlot = start + cost * this.intervalMs;
        if (start > now) await new Promise((r) => setTimeout(r, start - now));
    }
}

const limiters = new Map<string, RpcRateLimiter>();

function limiterFromEnv(envVar: string, fallbackPerSecond: number): RpcRateLimiter {
    let limiter = limiters.get(envVar);
    if (!limiter) {
        const configured = Number(process.env[envVar]);
        limiter = new RpcRateLimiter(configured > 0 ? configured : fallbackPerSecond);
        limiters.set(envVar, limiter);
    }
    return limiter;
}

/** The process-wide limiter for the primary endpoint, from RPC_MAX_REQUESTS_PER_SECOND. */
export function getRpcRateLimiter(): RpcRateLimiter {
    return limiterFromEnv('RPC_MAX_REQUESTS_PER_SECOND', DEFAULT_MAX_REQUESTS_PER_SECOND);
}

/** The process-wide limiter for the fallback endpoint, from RPC_FALLBACK_MAX_REQUESTS_PER_SECOND. */
export function getFallbackRpcRateLimiter(): RpcRateLimiter {
    return limiterFromEnv('RPC_FALLBACK_MAX_REQUESTS_PER_SECOND', DEFAULT_FALLBACK_MAX_REQUESTS_PER_SECOND);
}

// ---- Failover ----

/** How long every provider skips a primary endpoint after it failed for endpoint reasons. */
export const FAILOVER_COOLDOWN_MS = 30_000;

/** Primary URL → time until which it is skipped. Shared, so one provider's discovery spares the rest. */
const primaryOutages = new Map<string, number>();

/** Test hook: forget every recorded outage. */
export function resetRpcFailover(): void {
    primaryOutages.clear();
}

// JSON-RPC error codes that mean "this endpoint won't serve you right now",
// not "your call is wrong": -32005 limit exceeded (EIP-1474), -32007 QuickNode's
// per-second cap, -32029 used by some providers for rate limiting.
const ENDPOINT_ERROR_CODES = new Set([-32005, -32007, -32029]);
const ENDPOINT_ERROR_MESSAGE = /rate limit|request limit|too many requests|capacity exceeded/i;

function isEndpointRpcError(error: unknown): boolean {
    const e = (error ?? {}) as { code?: unknown; message?: unknown };
    return ENDPOINT_ERROR_CODES.has(Number(e.code))
        || (typeof e.message === 'string' && ENDPOINT_ERROR_MESSAGE.test(e.message));
}

/** A thrown transport failure: timeout, connection error, HTTP 429 or 5xx — anything but a 4xx client error. */
function isTransportFailure(err: unknown): boolean {
    const status = (err as { response?: { statusCode?: number } })?.response?.statusCode;
    return status === undefined || status === 429 || status >= 500;
}

/** An HTTP 429: the request was refused outright, so it certainly did not take effect. */
function isHttpRateLimit(err: unknown): boolean {
    return (err as { response?: { statusCode?: number } })?.response?.statusCode === 429;
}

function sendsTransaction(payload: ethers.JsonRpcPayload | Array<ethers.JsonRpcPayload>): boolean {
    return (Array.isArray(payload) ? payload : [payload]).some((p) => p.method === 'eth_sendRawTransaction');
}

function describeFailure(err: unknown): string {
    const e = err as { code?: unknown; message?: unknown; shortMessage?: unknown };
    const text = typeof e?.shortMessage === 'string' ? e.shortMessage : typeof e?.message === 'string' ? e.message : String(err);
    return e?.code !== undefined ? `${e.code}: ${text}` : text;
}

/** Timeout for a request to a primary endpoint that has a fallback (ethers' default is 5 minutes). */
export const PRIMARY_TIMEOUT_MS = 15_000;

/**
 * With a fallback available, waiting on the primary is wasted time: ethers
 * would otherwise retry an HTTP 429 up to 12 times with exponential backoff,
 * and wait up to 5 minutes for a hung request.
 */
function failFastRequest(url: string): ethers.FetchRequest {
    const request = new ethers.FetchRequest(url);
    request.retryFunc = async () => false;
    request.timeout = PRIMARY_TIMEOUT_MS;
    return request;
}

/**
 * A JsonRpcProvider whose every outgoing request waits for its endpoint's
 * limiter, and which re-sends to `fallback` when the primary endpoint fails.
 */
class ThrottledJsonRpcProvider extends ethers.JsonRpcProvider {
    constructor(
        private readonly url: string,
        network: ethers.Network,
        options: ethers.JsonRpcApiProviderOptions,
        private readonly limiter: RpcRateLimiter,
        private readonly fallback?: ThrottledJsonRpcProvider,
    ) {
        super(fallback ? failFastRequest(url) : url, network, options);
    }

    override async _send(payload: ethers.JsonRpcPayload | Array<ethers.JsonRpcPayload>): Promise<Array<ethers.JsonRpcResult>> {
        if (this.fallback && Date.now() < (primaryOutages.get(this.url) ?? 0)) {
            return this.fallback._send(payload);
        }

        await this.limiter.acquire(Array.isArray(payload) ? payload.length : 1);
        let results: Array<ethers.JsonRpcResult>;
        try {
            results = await super._send(payload);
        } catch (err) {
            // A transaction whose request failed in transit may still have
            // reached the node — re-sending it elsewhere would race the
            // original. Only a 429 proves it was refused.
            const canRetry = isTransportFailure(err) && (!sendsTransaction(payload) || isHttpRateLimit(err));
            if (!this.fallback || !canRetry) throw err;
            this.failOver(err);
            return this.fallback._send(payload);
        }

        const refused = results.find((r) => 'error' in r && isEndpointRpcError(r.error));
        if (this.fallback && refused && 'error' in refused) {
            this.failOver(refused.error);
            return this.fallback._send(payload);
        }
        if (primaryOutages.delete(this.url)) {
            console.log('[RPC] Primary endpoint answering again — switched back from fallback');
        }
        return results;
    }

    private failOver(reason: unknown): void {
        const alreadyDown = Date.now() < (primaryOutages.get(this.url) ?? 0);
        primaryOutages.set(this.url, Date.now() + FAILOVER_COOLDOWN_MS);
        if (!alreadyDown) {
            console.warn(`[RPC] Primary endpoint failed (${describeFailure(reason)}) — using fallback for ${FAILOVER_COOLDOWN_MS / 1000}s`);
            emitRpcFailover(describeFailure(reason));
        }
    }
}

export interface RpcProviderOptions {
    /** Network name for ethers; purely cosmetic. */
    name?: string;
    /** Limiter for the primary endpoint. Default: the process-wide one. */
    limiter?: RpcRateLimiter;
    /** Endpoint to re-send to when the primary fails. Default: MONAD_RPC_FALLBACK_URL. Pass null for none. */
    fallbackUrl?: string | null;
    /** Limiter for the fallback endpoint. Default: the process-wide fallback one. */
    fallbackLimiter?: RpcRateLimiter;
}

export function createRpcProvider(rpcUrl: string, chainId: number, options: RpcProviderOptions = {}): ethers.JsonRpcProvider {
    const network = ethers.Network.from({ chainId, name: options.name ?? 'monad' });
    // staticNetwork also skips the eth_chainId probe ethers otherwise repeats.
    const providerOptions = { staticNetwork: network, batchMaxCount: 1 };
    const fallbackUrl = options.fallbackUrl === undefined ? process.env.MONAD_RPC_FALLBACK_URL : options.fallbackUrl;
    const fallback = fallbackUrl && fallbackUrl !== rpcUrl
        ? new ThrottledJsonRpcProvider(fallbackUrl, network, providerOptions, options.fallbackLimiter ?? getFallbackRpcRateLimiter())
        : undefined;
    return new ThrottledJsonRpcProvider(rpcUrl, network, providerOptions, options.limiter ?? getRpcRateLimiter(), fallback);
}
