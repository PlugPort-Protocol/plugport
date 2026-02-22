import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
    title: 'PlugPort Dashboard - MongoDB on MonadDb',
    description: 'Manage your PlugPort MongoDB-compatible document store powered by MonadDb Merkle Patricia Trie',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
