'use client';

import { WalletProvider } from '@/lib/wallet-provider';
import { AuthProvider } from '@/lib/auth-context';

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <WalletProvider>
            <AuthProvider>{children}</AuthProvider>
        </WalletProvider>
    );
}
