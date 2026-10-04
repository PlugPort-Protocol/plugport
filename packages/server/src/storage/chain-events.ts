// Operational events from the chain layer, for metrics and alerting.
//
// The RPC provider and the transaction sequencer emit these; index.ts turns
// them into Prometheus counters. That keeps storage code free of any metrics
// dependency. Emitting with no listener is a no-op.

import { EventEmitter } from 'node:events';

export const chainEvents = new EventEmitter();

/** Every provider switched from an RPC endpoint to the next one in the fallback chain. */
export function emitRpcFailover(reason: string): void {
    chainEvents.emit('rpcFailover', reason);
}

/**
 * A server transaction failed: `send` covers fee estimation, signing and
 * broadcast (e.g. "insufficient balance"), `confirm` a revert or a timeout
 * waiting for the receipt.
 */
export function emitTxFailed(stage: 'send' | 'confirm', err: unknown): void {
    chainEvents.emit('txFailed', stage, err);
}

export function onRpcFailover(listener: (reason: string) => void): void {
    chainEvents.on('rpcFailover', listener);
}

export function onTxFailed(listener: (stage: 'send' | 'confirm', err: unknown) => void): void {
    chainEvents.on('txFailed', listener);
}
