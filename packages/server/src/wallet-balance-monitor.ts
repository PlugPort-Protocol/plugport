// Reports each gas-paying server wallet's balance as a Prometheus gauge, so an
// alert fires before a wallet runs dry.
//
// On 2026-09-28 the Store wallet ran out of MON and every document write failed
// with "Signer had insufficient balance" for two days before anyone noticed.

import { formatEther, type ethers } from 'ethers';
import type { MetricsCollector } from './metrics.js';

export const BALANCE_POLL_INTERVAL_MS = 5 * 60 * 1000;

export interface MonitoredWallet {
    role: string;
    address: string;
}

/**
 * Read every wallet's balance once. A failed read leaves that wallet's last
 * value in place (a missed poll is not an empty wallet) and logs a warning.
 */
export async function pollWalletBalances(
    provider: Pick<ethers.Provider, 'getBalance'>,
    wallets: MonitoredWallet[],
    metrics: Pick<MetricsCollector, 'setWalletBalance'>,
): Promise<void> {
    for (const { role, address } of wallets) {
        try {
            const wei = await provider.getBalance(address);
            metrics.setWalletBalance(role, address, Number(formatEther(wei)));
        } catch (err) {
            console.warn(`[Balances] Could not read the ${role} wallet balance (${address}):`, err instanceof Error ? err.message : err);
        }
    }
}

/**
 * Poll now and every `intervalMs`. One wallet can hold several roles (e.g. a
 * legacy single key); it is reported once per role so each alert names its role.
 * Returns a stop function.
 */
export function startWalletBalanceMonitor(
    provider: Pick<ethers.Provider, 'getBalance'>,
    wallets: MonitoredWallet[],
    metrics: Pick<MetricsCollector, 'setWalletBalance'>,
    intervalMs = BALANCE_POLL_INTERVAL_MS,
): () => void {
    const unique = wallets.filter((w, i) => wallets.findIndex((o) => o.role === w.role && o.address === w.address) === i);
    void pollWalletBalances(provider, unique, metrics);
    const timer = setInterval(() => { void pollWalletBalances(provider, unique, metrics); }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}
