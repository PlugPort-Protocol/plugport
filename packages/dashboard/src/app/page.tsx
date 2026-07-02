'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet, setServerUrl as setApiServerUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useBalance } from 'wagmi';
import { ThemeToggle } from './theme-toggle';
import { Icon } from '@/lib/icons';
import type { CollectionInfo, MetricsData, TabId } from './types';

// Tab components — extracted into individual files (I1)
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


// ---- Sidebar ----
function Sidebar({ activeTab, setActiveTab, health }: {
    activeTab: TabId;
    setActiveTab: (tab: TabId) => void;
    health: Record<string, unknown> | null;
}) {
    const navItems: { id: TabId; label: string; icon: string; section: string }[] = [
        { id: 'overview', label: 'Overview', icon: 'home', section: 'General' },
        { id: 'collections', label: 'Collections', icon: 'database', section: 'General' },
        { id: 'protocols', label: 'Protocols', icon: 'plug', section: 'General' },
        { id: 'query', label: 'Query Builder', icon: 'search', section: 'Data' },
        { id: 'explorer', label: 'Document Explorer', icon: 'eye', section: 'Data' },
        { id: 'indexes', label: 'Index Manager', icon: 'index', section: 'Performance' },
        { id: 'metrics', label: 'Metrics', icon: 'chart', section: 'Performance' },
        { id: 'deploy', label: 'Deploy & Gas', icon: 'zap', section: 'Infrastructure' },
        { id: 'privacy', label: 'Privacy & ACL', icon: 'lock', section: 'Security' },
        { id: 'apikeys', label: 'API Keys', icon: 'key', section: 'Security' },
    ];

    const sections = [...new Set(navItems.map(i => i.section))];

    return (
        <nav className="sidebar">
            <div className="sidebar-brand">
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <img src="/logo-with-text.png" alt="PlugPort Logo" width={200} height={50} style={{ borderRadius: 6 }} />
                   
                </div>
                <p>MonadDb Store</p>
            </div>
            <div className="sidebar-nav">
                {sections.map(section => (
                    <div className="nav-section" key={section}>
                        <div className="nav-section-label">{section}</div>
                        {navItems.filter(i => i.section === section).map(item => (
                            <button
                                key={item.id}
                                className={`nav-item ${activeTab === item.id ? 'active' : ''}`}
                                onClick={() => setActiveTab(item.id)}
                            >
                                <Icon name={item.icon} />
                                {item.label}
                            </button>
                        ))}
                    </div>
                ))}
            </div>
            <div className="sidebar-footer">
                <WalletSidebarFooter health={health} />
            </div>
        </nav>
    );
}

// ---- Wallet Sidebar Footer ----
function WalletSidebarFooter({ health }: { health: Record<string, unknown> | null }) {
    const { address, isAuthenticated, signIn, signOut, serverUrl, setServerUrl: setAuthServerUrl } = useAuth();
    const { isConnected } = useAccount();
    const { data: balance } = useBalance({ address: address as `0x${string}` | undefined });
    const [showSettings, setShowSettings] = useState(false);
    const [customUrl, setCustomUrl] = useState(serverUrl || '');

    // Sync server URL to API client
    useEffect(() => {
        setApiServerUrl(serverUrl);
    }, [serverUrl]);

    const handleSaveUrl = () => {
        const url = customUrl.trim();
        setAuthServerUrl(url || null);
        setShowSettings(false);
    };

    return (
        <div>
            {/* Connection status */}
            <div className="status-text" style={{ marginBottom: 12 }}>
                <span className="status-dot" style={{ background: health ? '#00d4aa' : '#ff4757' }} />
                {health ? 'Server Connected' : 'Server Disconnected'}
            </div>

            {/* Wallet connection */}
            {isConnected ? (
                <div>
                    {isAuthenticated ? (
                        <div style={{ fontSize: 12 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                <span className="status-dot" style={{ background: '#836ef9' }} />
                                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                                    {address?.slice(0, 6)}...{address?.slice(-4)}
                                </span>
                            </div>
                            {balance && (
                                <div style={{ color: 'var(--text-tertiary)', marginBottom: 8, fontFamily: 'JetBrains Mono', fontSize: 11 }}>
                                    {parseFloat(balance.formatted).toFixed(4)} {balance.symbol}
                                </div>
                            )}
                            <button className="btn btn-sm" style={{ width: '100%', background: 'rgba(255,71,87,0.1)', color: 'var(--accent-error)', border: '1px solid rgba(255,71,87,0.2)', fontSize: 11 }} onClick={signOut}>
                                Disconnect
                            </button>
                        </div>
                    ) : (
                        <div style={{ padding: '8px 0', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>
                            <div className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Awaiting Signature...
                        </div>
                    )}
                </div>
            ) : (
                <ConnectButton.Custom>
                    {({ openConnectModal }) => (
                        <button
                            className="btn btn-primary btn-sm"
                            style={{ width: '100%', fontSize: 12, background: 'var(--gradient-primary)', border: 'none' }}
                            onClick={openConnectModal}
                        >
                            <Icon name="wallet" size={14} /> Connect Wallet
                        </button>
                    )}
                </ConnectButton.Custom>
            )}

            {/* Settings & Theme */}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                    onClick={() => setShowSettings(!showSettings)}
                    style={{ flex: 1, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 11, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'center', padding: '6px 0' }}
                >
                    <Icon name="settings" size={12} /> Server Settings
                </button>
                <ThemeToggle />
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
                    <button className="btn btn-sm btn-secondary" style={{ width: '100%', marginTop: 4, fontSize: 11 }} onClick={handleSaveUrl}>
                        Save
                    </button>
                </div>
            )}
        </div>
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
        overview: { title: 'Dashboard Overview', subtitle: 'PlugPort server status and statistics' },
        collections: { title: 'Collections', subtitle: 'Browse and manage document collections' },
        protocols: { title: 'Protocol Frontends', subtitle: 'Manage database protocol servers (PostgreSQL, MySQL, Redis, MongoDB)' },
        query: { title: 'Query Builder', subtitle: 'Build and execute MongoDB-compatible queries' },
        explorer: { title: 'Document Explorer', subtitle: 'Browse, edit, and delete documents' },
        indexes: { title: 'Index Manager', subtitle: 'Create and manage collection indexes' },
        metrics: { title: 'Metrics & Monitoring', subtitle: 'Server performance and health metrics' },
        deploy: { title: 'Deploy & Gas Station', subtitle: 'Deploy contracts and manage gas station balance' },
        privacy: { title: 'Privacy & ACL', subtitle: 'Per-collection encryption and address whitelists' },
        apikeys: { title: 'API Keys & Analytics', subtitle: 'Generate wallet-linked API keys and monitor usage' },
    };

    return (
        <div className="app-layout">
            <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} health={health} />
            <main className="main-content">
                <div className="page-header">
                    <h2 className="page-title">{tabTitles[activeTab].title}</h2>
                    <p className="page-subtitle">{tabTitles[activeTab].subtitle}</p>
                </div>
                <div className="page-body">
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
                </div>
            </main>
        </div>
    );
}
