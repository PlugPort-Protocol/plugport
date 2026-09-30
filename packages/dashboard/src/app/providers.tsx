'use client';

import { WalletProvider } from '@/lib/wallet-provider';
import { AuthProvider } from '@/lib/auth-context';
import { ThemeProvider } from 'next-themes';
import { Toaster } from 'react-hot-toast';

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <ThemeProvider attribute="data-theme" defaultTheme="dark" enableSystem>
            <WalletProvider>
                <AuthProvider>{children}</AuthProvider>
                <Toaster
                    position="top-right"
                    toastOptions={{
                        duration: 5000,
                        style: {
                            background: 'var(--bg-glass)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--border-primary)',
                            backdropFilter: 'blur(20px)',
                            fontSize: 13,
                        },
                    }}
                />
            </WalletProvider>
        </ThemeProvider>
    );
}
