// Signals the Grafana alerts are built on. The Store wallet ran dry on 2026-09-28
// and every write failed for two days unnoticed; these metrics are what would
// have raised it within minutes.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ethers } from 'ethers';
import { MetricsCollector } from '../metrics.js';
import { chainEvents, onTxFailed, onRpcFailover, emitRpcFailover } from '../storage/chain-events.js';
import { sendContractTx, confirmTx } from '../storage/tx-sequencer.js';
import { pollWalletBalances, startWalletBalanceMonitor } from '../wallet-balance-monitor.js';

afterEach(() => {
    chainEvents.removeAllListeners();
    vi.restoreAllMocks();
});

describe('MetricsCollector alerting metrics', () => {
    it('exports the counters, balances and heap limit the alerts query', async () => {
        const metrics = new MetricsCollector();
        metrics.recordRpcFailover();
        metrics.recordTxFailure('send');
        metrics.recordTxFailure('send');
        metrics.setWalletBalance('store', '0xabc', 4.75);

        const text = await metrics.getPrometheusMetrics();
        expect(text).toMatch(/^plugport_rpc_failovers_total 1$/m);
        expect(text).toMatch(/^plugport_chain_tx_failures_total\{stage="send"\} 2$/m);
        expect(text).toMatch(/^plugport_wallet_balance_mon\{role="store",address="0xabc"\} 4\.75$/m);
        expect(text).toMatch(/^plugport_heap_limit_bytes [1-9]\d+$/m);
    });
});

describe('chain events', () => {
    it('reports a transaction that could not be sent (e.g. insufficient balance)', async () => {
        const failures: string[] = [];
        onTxFailed((stage) => failures.push(stage));
        const signer = {} as ethers.Signer;
        const populate = () => Promise.reject(new Error('Signer had insufficient balance'));
        await expect(sendContractTx(signer, populate)).rejects.toThrow(/insufficient balance/);
        expect(failures).toEqual(['send']);
    });

    it('reports a transaction that reverted on chain', async () => {
        const failures: string[] = [];
        onTxFailed((stage) => failures.push(stage));
        const tx = {
            hash: '0x01',
            provider: { getTransactionReceipt: async () => ({ status: 0, to: '0x02', from: '0x03' }) },
        } as unknown as ethers.TransactionResponse;
        await expect(confirmTx(tx)).rejects.toThrow(/reverted/);
        expect(failures).toEqual(['confirm']);
    });

    it('delivers RPC failovers to listeners', () => {
        const reasons: string[] = [];
        onRpcFailover((r) => reasons.push(r));
        emitRpcFailover('SERVER_ERROR: 429');
        expect(reasons).toEqual(['SERVER_ERROR: 429']);
    });
});

describe('wallet balance monitor', () => {
    const wallets = [
        { role: 'store', address: '0xstore' },
        { role: 'auth', address: '0xauth' },
    ];

    it('sets each wallet balance in MON', async () => {
        const set = vi.fn();
        const provider = { getBalance: vi.fn(async (a: string) => (a === '0xstore' ? 4_758_374_083_000_000_000n : 10n ** 18n)) };
        await pollWalletBalances(provider as never, wallets, { setWalletBalance: set });
        expect(set).toHaveBeenCalledWith('store', '0xstore', 4.758374083);
        expect(set).toHaveBeenCalledWith('auth', '0xauth', 1);
    });

    it('leaves the last value alone when a read fails — a missed poll is not an empty wallet', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        const set = vi.fn();
        const provider = { getBalance: vi.fn(async (a: string) => { if (a === '0xstore') throw new Error('429'); return 1n; }) };
        await pollWalletBalances(provider as never, wallets, { setWalletBalance: set });
        expect(set).toHaveBeenCalledTimes(1);
        expect(set).toHaveBeenCalledWith('auth', '0xauth', 1e-18);
    });

    it('polls immediately and on its interval, once per role and address', async () => {
        vi.useFakeTimers();
        try {
            const set = vi.fn();
            const provider = { getBalance: vi.fn(async () => 0n) };
            const stop = startWalletBalanceMonitor(provider as never, [...wallets, wallets[0]], { setWalletBalance: set }, 1000);
            await vi.advanceTimersByTimeAsync(0);
            expect(provider.getBalance).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(1000);
            expect(provider.getBalance).toHaveBeenCalledTimes(4);
            stop();
        } finally {
            vi.useRealTimers();
        }
    });
});
