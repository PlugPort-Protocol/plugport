import './globals.css';
import type { Metadata } from 'next';
import { DM_Sans, JetBrains_Mono } from 'next/font/google';
import { Providers } from './providers';

const dmSans = DM_Sans({
    subsets: ['latin'],
    weight: ['400', '500', '600', '700'],
    variable: '--font-dm-sans',
    display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
    subsets: ['latin'],
    weight: ['400', '500', '600', '700'],
    variable: '--font-jetbrains-mono',
    display: 'swap',
});

export const metadata: Metadata = {
    title: 'PlugPort Dashboard — Multi-Protocol Database on Monad',
    description: 'Universal dashboard for PlugPort. Connect your wallet to manage databases, deploy contracts, and monitor analytics.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" suppressHydrationWarning className={`${dmSans.variable} ${jetbrainsMono.variable}`}>
            <body>
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
