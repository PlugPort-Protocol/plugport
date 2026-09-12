'use client';

import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import { motion, AnimatePresence } from 'framer-motion';
import * as Popover from '@radix-ui/react-popover';
import { apiGet, setServerUrl as setApiServerUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useBalance } from 'wagmi';
import { ThemeToggle } from './theme-toggle';
import { Icon } from '@/lib/icons';
import type { CollectionInfo, MetricsData, TabId } from './types';

import {
    OverviewTab,
    CollectionsTab,
    QueryBuilderTab,
    DocumentExplorerTab,
    IndexManagerTab,
    MetricsTab,
    ProtocolsTab,
    PrivacyTab,
    DeployTab,
    ApiKeysTab,
} from './components';

// ---- Dock (macOS-style capsule rail) ----
function Dock({ activeTab, setActiveTab, health }: {
    activeTab: TabId;
    setActiveTab: (tab: TabId) => void;
    health: Record<string, unknown> | null;
}) {
    const navItems: { id: TabId; label: string; icon: string }[] = [
        { id: 'overview', label: 'Overview', icon: 'home' },
        { id: 'collections', label: 'Collections', icon: 'database' },
        { id: 'protocols', label: 'Protocols', icon: 'plug' },
        { id: 'query', label: 'Query Builder', icon: 'search' },
        { id: 'explorer', label: 'Document Explorer', icon: 'eye' },
        { id: 'indexes', label: 'Index Manager', icon: 'index' },
        { id: 'metrics', label: 'Metrics', icon: 'chart' },
        { id: 'deploy', label: 'Deploy & Gas', icon: 'zap' },
        { id: 'privacy', label: 'Privacy & ACL', icon: 'lock' },
        { id: 'apikeys', label: 'API Keys', icon: 'key' },
    ];

    return (
        <nav className="dock">
            <div className="dock-logo" title="PlugPort">
                <Image src="/plugport_logo.svg" alt="PlugPort" width={18} height={18} priority />
            </div>
            <div className="dock-sep" />
            {navItems.map(item => (
                <motion.button
                    key={item.id}
                    className={`dock-item ${activeTab === item.id ? 'active' : ''}`}
                    onClick={() => setActiveTab(item.id)}
                    whileHover={{ scale: 1.08 }}
                    whileTap={{ scale: 0.95 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                >
                    <Icon name={item.icon} size={18} />
                    <span className="dock-label">{item.label}</span>
                </motion.button>
            ))}
            <div className="dock-sep" />
            <WalletDockItem health={health} />
        </nav>
    );
}

// ---- Wallet dock item + popover panel ----
function WalletDockItem({ health }: { health: Record<string, unknown> | null }) {
    const { address, isAuthenticated, signOut, serverUrl, setServerUrl: setAuthServerUrl } = useAuth();
    const { isConnected } = useAccount();
    const { data: balance } = useBalance({ address: address as `0x${string}` | undefined });
    const [open, setOpen] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [customUrl, setCustomUrl] = useState(serverUrl || '');

    useEffect(() => {
        setApiServerUrl(serverUrl);
    }, [serverUrl]);

    const handleSaveUrl = () => {
        const url = customUrl.trim();
        setAuthServerUrl(url || null);
        setShowSettings(false);
    };

    const walletLabel = isConnected && isAuthenticated && address
        ? `${address.slice(0, 6)}…${address.slice(-4)}${balance ? ` · ${parseFloat(balance.formatted).toFixed(4)} ${balance.symbol}` : ''}`
        : 'Wallet & Settings';

    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
                <button className={`dock-item ${open ? 'active' : ''}`}>
                    <Icon name="wallet" size={18} />
                    <span className="dock-label">{walletLabel}</span>
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content className="dock-panel" side="right" align="end" sideOffset={14} collisionPadding={16}>
                    {/* Connection status */}
                    <div className="status-text" style={{ marginBottom: 12 }}>
                        <span className="status-dot" style={{ background: health ? 'var(--accent-success)' : 'var(--accent-error)' }} />
                        {health ? 'Connected' : 'Disconnected'}
                    </div>

                    {/* Wallet */}
                    {isConnected ? (
                        isAuthenticated ? (
                            <div style={{ fontSize: 12 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                    <span className="status-dot" style={{ background: 'var(--accent-primary)' }} />
                                    <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                                        {address?.slice(0, 6)}...{address?.slice(-4)}
                                    </span>
                                </div>
                                {balance && (
                                    <div className="wallet-balance" style={{ marginBottom: 10 }}>
                                        {parseFloat(balance.formatted).toFixed(4)}
                                        <span className="wallet-balance-unit">{balance.symbol}</span>
                                    </div>
                                )}
                                <button className="btn btn-danger btn-sm" style={{ width: '100%', justifyContent: 'center' }} onClick={signOut}>
                                    Disconnect
                                </button>
                            </div>
                        ) : (
                            <div className="status-text" style={{ justifyContent: 'center', padding: '8px 0' }}>
                                <div className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Awaiting Signature...
                            </div>
                        )
                    ) : (
                        <ConnectButton.Custom>
                            {({ openConnectModal }) => (
                                <button className="btn btn-primary btn-sm" style={{ width: '100%', justifyContent: 'center' }} onClick={openConnectModal}>
                                    <Icon name="wallet" size={14} /> Connect Wallet
                                </button>
                            )}
                        </ConnectButton.Custom>
                    )}

                    {/* Settings */}
                    <div style={{ marginTop: 10 }}>
                        <button className="btn btn-secondary btn-sm" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setShowSettings(!showSettings)}>
                            <Icon name="settings" size={12} /> Server
                        </button>
                    </div>

                    {showSettings && (
                        <div style={{ marginTop: 8 }}>
                            <input
                                className="input input-mono"
                                style={{ fontSize: 11, padding: '6px 8px' }}
                                value={customUrl}
                                onChange={e => setCustomUrl(e.target.value)}
                                placeholder="http://localhost:8080"
                            />
                            <button className="btn btn-sm btn-secondary" style={{ width: '100%', marginTop: 6, justifyContent: 'center' }} onClick={handleSaveUrl}>
                                Save
                            </button>
                        </div>
                    )}
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}

// ---- Main Dashboard ----
export default function Dashboard() {
    const [activeTab, setActiveTab] = useState<TabId>('overview');
    const [collections, setCollections] = useState<CollectionInfo[]>([]);
    const [metrics, setMetrics] = useState<MetricsData | null>(null);
    const [health, setHealth] = useState<Record<string, unknown> | null>(null);

    const loadCollections = useCallback(async () => {
        try {
            const res = await apiGet<{ collections: CollectionInfo[] }>('/api/v1/collections');
            setCollections(res.collections);
        } catch { /* ignore */ }
    }, []);

    const loadMetrics = useCallback(async () => {
        try {
            const res = await apiGet<MetricsData>('/api/v1/metrics');
            setMetrics(res);
        } catch { /* ignore */ }
    }, []);

    const loadHealth = useCallback(async () => {
        try {
            const res = await apiGet<Record<string, unknown>>('/health');
            setHealth(res);
        } catch { setHealth(null); }
    }, []);

    useEffect(() => {
        loadCollections();
        loadMetrics();
        loadHealth();
        const interval = setInterval(() => {
            loadMetrics();
            loadCollections();
        }, 5000);
        return () => clearInterval(interval);
    }, [loadCollections, loadMetrics, loadHealth]);

    const tabTitles: Record<TabId, { title: string; subtitle: string }> = {
        overview: { title: 'Overview', subtitle: 'plugport console · monaddb store' },
        collections: { title: 'Collections', subtitle: 'browse and manage document collections' },
        protocols: { title: 'Protocols', subtitle: 'postgresql · mysql · redis · mongodb frontends' },
        query: { title: 'Query Builder', subtitle: 'mongo · sql · redis — one verifiable engine' },
        explorer: { title: 'Document Explorer', subtitle: 'browse, edit and delete documents' },
        indexes: { title: 'Index Manager', subtitle: 'create and manage collection indexes' },
        metrics: { title: 'Metrics', subtitle: 'server performance and health' },
        deploy: { title: 'Deploy & Gas', subtitle: 'contracts and gas station on monad' },
        privacy: { title: 'Privacy & ACL', subtitle: 'per-collection encryption and whitelists' },
        apikeys: { title: 'API Keys', subtitle: 'wallet-linked keys and usage analytics' },
    };

    return (
        <div className="app-layout">
            <Dock activeTab={activeTab} setActiveTab={setActiveTab} health={health} />
            <main className="main-content">
                <div className="page-header">
                    <div>
                        <h2 className="page-title">{tabTitles[activeTab].title}</h2>
                        <p className="page-subtitle">{tabTitles[activeTab].subtitle}</p>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span className="status-text" style={{ border: '1px solid var(--border-primary)', background: 'var(--bg-card)', padding: '6px 12px', borderRadius: 100, boxShadow: 'var(--shadow-sm)' }}>
                            <span className="status-dot" style={{ background: health ? 'var(--accent-success)' : 'var(--accent-error)' }} />
                            {health ? 'connected' : 'disconnected'}
                        </span>
                        <ThemeToggle />
                    </div>
                </div>
                <div className="page-body">
                    <AnimatePresence mode="wait">
                        <motion.div
                            key={activeTab}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -6 }}
                            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                        >
                            {activeTab === 'overview' && <OverviewTab collections={collections} metrics={metrics} />}
                            {activeTab === 'collections' && <CollectionsTab collections={collections} onRefresh={loadCollections} />}
                            {activeTab === 'protocols' && <ProtocolsTab />}
                            {activeTab === 'query' && <QueryBuilderTab collections={collections} />}
                            {activeTab === 'explorer' && <DocumentExplorerTab collections={collections} />}
                            {activeTab === 'indexes' && <IndexManagerTab collections={collections} onRefresh={loadCollections} />}
                            {activeTab === 'metrics' && <MetricsTab metrics={metrics} />}
                            {activeTab === 'deploy' && <DeployTab />}
                            {activeTab === 'privacy' && <PrivacyTab collections={collections} />}
                            {activeTab === 'apikeys' && <ApiKeysTab />}
                        </motion.div>
                    </AnimatePresence>
                </div>
            </main>
        </div>
    );
}
