'use client';

import { ReactNode } from 'react';
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

export const monadTestnet = defineChain({
    id: 10143,
    name: 'Monad Testnet',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: {
        default: { http: ['https://monad-testnet.drpc.org'] },
    },
    blockExplorers: {
        default: { name: 'Monad Explorer', url: 'https://testnet.monadexplorer.com' },
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

    // B5 fix: Dynamically switch RainbowKit theme based on next-themes
    const rainbowTheme = resolvedTheme === 'dark'
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
