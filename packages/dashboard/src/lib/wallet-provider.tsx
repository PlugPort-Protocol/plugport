'use client';

import { ReactNode } from 'react';
import '@rainbow-me/rainbowkit/styles.css';
import {
    RainbowKitProvider,
    getDefaultConfig,
    darkTheme,
} from '@rainbow-me/rainbowkit';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { defineChain } from 'viem';

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

// ---- Provider Component ----

export function WalletProvider({ children }: { children: ReactNode }) {
    return (
        <WagmiProvider config={config}>
            <QueryClientProvider client={queryClient}>
                <RainbowKitProvider
                    theme={darkTheme({
                        accentColor: '#836ef9',
                        accentColorForeground: 'white',
                        borderRadius: 'medium',
                        fontStack: 'system',
                        overlayBlur: 'small',
                    })}
                    modalSize="compact"
                >
                    {children}
                </RainbowKitProvider>
            </QueryClientProvider>
        </WagmiProvider>
    );
}

export { config as wagmiConfig };
