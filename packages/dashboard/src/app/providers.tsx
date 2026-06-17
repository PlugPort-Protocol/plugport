'use client';

import { WalletProvider } from '@/lib/wallet-provider';
import { AuthProvider } from '@/lib/auth-context';
import { ThemeProvider } from 'next-themes';

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <ThemeProvider attribute="data-theme" defaultTheme="dark" enableSystem>
            <WalletProvider>
                <AuthProvider>{children}</AuthProvider>
            </WalletProvider>
        </ThemeProvider>
    );
}
