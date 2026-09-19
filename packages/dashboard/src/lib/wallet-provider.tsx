'use client';

import { ReactNode, useEffect, useState } from 'react';
import '@rainbow-me/rainbowkit/styles.css';
import {
    RainbowKitProvider,
    getDefaultConfig,
    darkTheme,
    lightTheme,
} from '@rainbow-me/rainbowkit';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { defineChain } from 'viem';
import { useTheme } from 'next-themes';

// ---- Monad Chain Definitions ----

/**
 * The chain this deployment's contracts live on (baked in at build time, the
 * same variable the EIP-712 domain uses). The wallet is switched to this
 * automatically on connect, and again before signing on-chain key actions.
 */
export const TARGET_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 10143);

export const monadTestnet = defineChain({
    id: 10143,
    name: 'Monad Testnet',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: {
        default: { http: ['https://testnet-rpc.monad.xyz'] },
    },
    blockExplorers: {
        default: { name: 'MonadScan', url: 'https://testnet.monadscan.com' },
    },
    testnet: true,
});

export const monadMainnet = defineChain({
    id: 10144,
    name: 'Monad',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: {
        default: { http: ['https://monad.drpc.org'] },
    },
    blockExplorers: {
        default: { name: 'Monad Explorer', url: 'https://monadexplorer.com' },
    },
    testnet: false,
});

// ---- Wagmi + RainbowKit Configuration ----

const config = getDefaultConfig({
    appName: 'PlugPort Dashboard',
    projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'plugport-dev',
    chains: [monadTestnet, monadMainnet],
    ssr: true,
});

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 1000 * 60, // 1 minute
            retry: 2,
        },
    },
});

// ---- Theme-aware RainbowKit config ----

const rainbowThemeConfig = {
    accentColor: '#836ef9',
    accentColorForeground: 'white',
    borderRadius: 'medium' as const,
    fontStack: 'system' as const,
    overlayBlur: 'small' as const,
};

// ---- Provider Component ----

export function WalletProvider({ children }: { children: ReactNode }) {
    const { resolvedTheme } = useTheme();

    // `resolvedTheme` is undefined on the server and on the client's first
    // paint (next-themes defers it to avoid a flash of the wrong theme).
    // Picking a theme from it immediately means the server and the first
    // client render can disagree about which RainbowKit theme was used,
    // which shows up as a hydration mismatch on RainbowKit's injected
    // <style data-rk> tag. Deferring the swap to after mount keeps the
    // first render consistent on both sides.
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    // B5 fix: Dynamically switch RainbowKit theme based on next-themes
    const rainbowTheme = mounted && resolvedTheme === 'dark'
        ? darkTheme(rainbowThemeConfig)
        : lightTheme(rainbowThemeConfig);

    return (
        <WagmiProvider config={config}>
            <QueryClientProvider client={queryClient}>
                <RainbowKitProvider
                    theme={rainbowTheme}
                    modalSize="compact"
                >
                    {children}
                </RainbowKitProvider>
            </QueryClientProvider>
        </WagmiProvider>
    );
}

export { config as wagmiConfig };
