import './globals.css';
import type { Metadata } from 'next';
import { Providers } from './providers';

export const metadata: Metadata = {
    title: 'PlugPort Dashboard — Multi-Protocol Database on Monad',
    description: 'Universal dashboard for PlugPort. Connect your wallet to manage databases, deploy contracts, and monitor analytics.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
