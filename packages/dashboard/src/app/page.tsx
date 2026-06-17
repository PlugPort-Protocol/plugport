'use client';

import { useState, useEffect, useCallback } from 'react';
import { useApi, apiPost, apiGet, apiDelete, apiPut, setServerUrl as setApiServerUrl, setAuthToken } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useBalance } from 'wagmi';
import { useContractDeployer, type DeploymentState, type GasStationInfo } from '@/lib/contract-deployer';

// ---- Types ----
interface CollectionInfo {
    name: string;
    documentCount: number;
    indexCount: number;
    createdAt: number;
}

interface IndexInfo {
    name: string;
    field: string;
    unique: boolean;
}

interface MetricsData {
    requests: { total: number; byCommand: Record<string, number>; byProtocol: { http: number; wire: number } };
    latency: { p50: number; p95: number; p99: number; avg: number };
    errors: { total: number; byCode: Record<number, number> };
    storage: { keyCount: number; estimatedSizeBytes: number };
    uptime: number;
    timestamp: number;
}

interface ProtocolInfo {
    name: string;
    enabled: boolean;
    port: number;
    connections: number;
    connectionString: string;
}

interface ApiKeyInfo {
    hash: string;
    ownerAddress: string;
    label: string;
    createdAt: number;
    permissions: string[];
    rateLimit: number;
    active: boolean;
}

interface KeyAnalytics {
    keyHash: string;
    totalRequests: number;
    firstSeen: number;
    lastSeen: number;
    daily: Array<{ date: string; requests: number; errors: number; avgLatencyMs: number; errorRate: number }>;
    operations: Record<string, number>;
    collections: Record<string, number>;
}

interface UserMetrics {
    address: string;
    collections: number;
    documents: number;
    apiKeys: number;
    totalRequests: number;
}

type TabId = 'overview' | 'collections' | 'query' | 'indexes' | 'metrics' | 'explorer' | 'protocols' | 'privacy' | 'apikeys' | 'deploy';

// ---- Reusable Scope Toggle ----
function ScopeToggle({ scope, setScope }: { scope: 'my' | 'all'; setScope: (s: 'my' | 'all') => void }) {
    return (
        <div className="scope-toggle">
            <button
                className={`scope-toggle-btn ${scope === 'my' ? 'active' : ''}`}
                onClick={() => setScope('my')}
            >
                My Data
            </button>
            <button
                className={`scope-toggle-btn ${scope === 'all' ? 'active' : ''}`}
                onClick={() => setScope('all')}
            >
                All Data
            </button>
        </div>
    );
}

// ---- Icons (inline SVG for zero dependency) ----
const Icon = ({ name, size = 20 }: { name: string; size?: number }) => {
    const icons: Record<string, string> = {
        home: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
        database: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4',
        search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
        chart: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
        index: 'M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12',
        code: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
        play: 'M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z',
        plus: 'M12 4v16m8-8H4',
        trash: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16',
        refresh: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
        download: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4',
        zap: 'M13 10V3L4 14h7v7l9-11h-7z',
        server: 'M5 12H3l9-9 9 9h-2M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7',
        eye: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z',
        plug: 'M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z',
        lock: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
        key: 'M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z',
        wallet: 'M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z',
        settings: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    };
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="nav-icon">
            <path d={icons[name] || icons.home} />
        </svg>
    );
};

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
    const { address, isAuthenticated, jwt, signIn, signOut, serverUrl, setServerUrl: setAuthServerUrl } = useAuth();
    const { isConnected } = useAccount();
    const { data: balance } = useBalance({ address: address as `0x${string}` | undefined });
    const [showSettings, setShowSettings] = useState(false);
    const [customUrl, setCustomUrl] = useState(serverUrl || '');
    const [signingIn, setSigningIn] = useState(false);

    // Sync auth token to API client
    useEffect(() => {
        setAuthToken(jwt);
    }, [jwt]);

    useEffect(() => {
        setApiServerUrl(serverUrl);
    }, [serverUrl]);

    const handleSignIn = async () => {
        setSigningIn(true);
        try {
            await signIn();
        } catch (err) {
            console.error('Sign-in failed:', err);
        } finally {
            setSigningIn(false);
        }
    };

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
                        <button
                            className="btn btn-primary btn-sm"
                            style={{ width: '100%', fontSize: 12 }}
                            onClick={handleSignIn}
                            disabled={signingIn}
                        >
                            {signingIn ? <div className="spinner" style={{ width: 14, height: 14 }} /> : 'Sign In (SIWE)'}
                        </button>
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

            {/* Settings toggle */}
            <button
                onClick={() => setShowSettings(!showSettings)}
                style={{ marginTop: 8, width: '100%', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'center', padding: '4px 0' }}
            >
                <Icon name="settings" size={12} /> Server Settings
            </button>

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

// ---- Overview Tab ----
function OverviewTab({ collections, metrics }: { collections: CollectionInfo[]; metrics: MetricsData | null }) {
    const { address, isAuthenticated } = useAuth();
    const [userMetrics, setUserMetrics] = useState<UserMetrics | null>(null);
    const totalDocs = collections.reduce((s, c) => s + c.documentCount, 0);
    const totalIndexes = collections.reduce((s, c) => s + c.indexCount, 0);

    useEffect(() => {
        if (isAuthenticated && address) {
            apiGet<UserMetrics>(`/api/v1/user/${address}/metrics`).then(setUserMetrics).catch(() => {});
        }
    }, [isAuthenticated, address]);

    return (
        <div className="fade-in ">
            {/* User-scoped stats (when wallet connected) */}
            {isAuthenticated && userMetrics && (
                <div style={{ marginBottom: 24 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent-primary-light)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>My Account</div>
                    <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                        <div className="stat-card" style={{ borderLeft: '3px solid var(--accent-primary)' }}>
                            <div className="stat-label">My Collections</div>
                            <div className="stat-value">{userMetrics.collections}</div>
                        </div>
                        <div className="stat-card" style={{ borderLeft: '3px solid var(--accent-secondary)' }}>
                            <div className="stat-label">My Documents</div>
                            <div className="stat-value">{userMetrics.documents.toLocaleString()}</div>
                        </div>
                        <div className="stat-card" style={{ borderLeft: '3px solid var(--accent-tertiary)' }}>
                            <div className="stat-label">API Keys</div>
                            <div className="stat-value">{userMetrics.apiKeys}</div>
                        </div>
                        <div className="stat-card" style={{ borderLeft: '3px solid var(--accent-info)' }}>
                            <div className="stat-label">My Requests</div>
                            <div className="stat-value">{userMetrics.totalRequests.toLocaleString()}</div>
                        </div>
                    </div>
                </div>
            )}

            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-tertiary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Global Stats</div>
            <div className="stats-grid ">
                <div className="stat-card">
                    <div className="stat-label">Collections</div>
                    <div className="stat-value">{collections.length}</div>
                    <div className="stat-change">Active namespaces</div>
                </div>
                <div className="stat-card">
                    <div className="stat-label">Documents</div>
                    <div className="stat-value">{totalDocs.toLocaleString()}</div>
                    <div className="stat-change">Across all collections</div>
                </div>
                <div className="stat-card">
                    <div className="stat-label">Indexes</div>
                    <div className="stat-value">{totalIndexes}</div>
                    <div className="stat-change">Including _id indexes</div>
                </div>
                <div className="stat-card">
                    <div className="stat-label">QPS</div>
                    <div className="stat-value">{metrics ? Math.round(metrics.requests.total / Math.max(1, metrics.uptime / 1000)) : 0}</div>
                    <div className="stat-change">Queries per second</div>
                </div>
            </div>

            <div className="grid-2">
                <div className="card">
                    <div className="card-header">
                        <div className="card-title">Recent Collections</div>
                    </div>
                    {collections.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-state-title">No collections yet</div>
                            <div className="empty-state-text">Insert a document to auto-create a collection</div>
                        </div>
                    ) : (
                        <div className="table-container">
                            <table className="table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Documents</th>
                                        <th>Indexes</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {collections.map(c => (
                                        <tr key={c.name}>
                                            <td style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{c.name}</td>
                                            <td>{c.documentCount.toLocaleString()}</td>
                                            <td>{c.indexCount}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                <div className="card">
                    <div className="card-header">
                        <div className="card-title">Performance</div>
                    </div>
                    {metrics ? (
                        <div>
                            <div style={{ display: 'grid', gap: '12px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-primary)' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>Avg Latency</span>
                                    <span style={{ fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{metrics.latency.avg.toFixed(1)}ms</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-primary)' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>P95 Latency</span>
                                    <span style={{ fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{metrics.latency.p95.toFixed(1)}ms</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-primary)' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>P99 Latency</span>
                                    <span style={{ fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{metrics.latency.p99.toFixed(1)}ms</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-primary)' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>Total Requests</span>
                                    <span style={{ fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{metrics.requests.total.toLocaleString()}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-primary)' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>Errors</span>
                                    <span style={{ fontWeight: 600, fontFamily: 'JetBrains Mono', color: metrics.errors.total > 0 ? 'var(--accent-error)' : 'var(--accent-success)' }}>{metrics.errors.total}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>Uptime</span>
                                    <span style={{ fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{formatUptime(metrics.uptime)}</span>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="loading-center"><div className="spinner" /></div>
                    )}
                </div>
            </div>

            {/* Architecture highlight */}
            <div className="card" style={{ marginTop: 24 }}>
                <div className="card-header">
                    <div className="card-title">Architecture: MonadDb Advantage</div>
                    <span className="badge badge-primary">Powered by Monad</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginTop: 12 }}>
                    <div style={{ padding: '16px', background: 'rgba(131,110,249,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(131,110,249,0.1)' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: 'var(--accent-primary-light)' }}>Merkle Patricia Trie</div>
                        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>Every document write produces a cryptographic proof. Verifiable storage with O(log n) lookups via MonadDb's optimized trie structure.</div>
                    </div>
                    <div style={{ padding: '16px', background: 'rgba(0,212,170,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(0,212,170,0.1)' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: 'var(--accent-secondary)' }}>Parallel Execution</div>
                        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>Monad's 10,000 TPS execution layer enables high-throughput document operations. Concurrent index maintenance without lock contention.</div>
                    </div>
                    <div style={{ padding: '16px', background: 'rgba(255,107,157,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(255,107,157,0.1)' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: 'var(--accent-tertiary)' }}>Wire Protocol Compatible</div>
                        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>Connect with mongosh, Node.js, Python, and Go drivers. Drop-in replacement for MongoDB with verifiable blockchain-backed storage.</div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ---- Collections Tab ----
function CollectionsTab({ collections, onRefresh }: { collections: CollectionInfo[]; onRefresh: () => void }) {
    const [showInsert, setShowInsert] = useState(false);
    const [insertCollection, setInsertCollection] = useState('');
    const [insertDoc, setInsertDoc] = useState('{\n  "name": "Alice",\n  "email": "alice@example.com"\n}');
    const [insertResult, setInsertResult] = useState<string | null>(null);

    const handleInsert = async () => {
        try {
            const doc = JSON.parse(insertDoc);
            const result = await apiPost(`/api/v1/collections/${insertCollection}/insertOne`, { document: doc });
            setInsertResult(JSON.stringify(result, null, 2));
            onRefresh();
        } catch (err) {
            setInsertResult(`Error: ${err instanceof Error ? err.message : 'Unknown'}`);
        }
    };

    return (
        <div className="fade-in">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
                <button className="btn btn-primary" onClick={() => setShowInsert(!showInsert)}>
                    <Icon name="plus" size={16} /> Insert Document
                </button>
                <button className="btn btn-secondary" onClick={onRefresh}>
                    <Icon name="refresh" size={16} /> Refresh
                </button>
            </div>

            {showInsert && (
                <div className="card" style={{ marginBottom: 24 }}>
                    <div className="card-title" style={{ marginBottom: 16 }}>Insert Document</div>
                    <div className="grid-2">
                        <div className="input-group">
                            <label className="label">Collection Name</label>
                            <input className="input" value={insertCollection} onChange={e => setInsertCollection(e.target.value)} placeholder="users" />
                        </div>
                        <div />
                    </div>
                    <div className="input-group">
                        <label className="label">Document (JSON)</label>
                        <textarea className="textarea" value={insertDoc} onChange={e => setInsertDoc(e.target.value)} rows={6} />
                    </div>
                    <button className="btn btn-primary" onClick={handleInsert} disabled={!insertCollection}>
                        <Icon name="play" size={16} /> Insert
                    </button>
                    {insertResult && (
                        <pre className="json-view" style={{ marginTop: 16 }}>{insertResult}</pre>
                    )}
                </div>
            )}

            {collections.length === 0 ? (
                <div className="card" style={{ padding: '64px 32px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div className="relative group mb-8" style={{ position: 'relative' }}>
                        <div style={{ 
                            width: 80, 
                            height: 80, 
                            background: 'var(--bg-tertiary)', 
                            borderRadius: '24px', 
                            display: 'flex', 
                            alignItems: 'center', 
                            justifyContent: 'center',
                            position: 'relative'
                        }}>
                            {/* <span className="material-icons-outlined" style={{ fontSize: 40, color: 'var(--text-tertiary)' }}>database</span> */}
                            <Icon name="database" size={48} />
                            <div style={{ 
                                position: 'absolute',
                                bottom: -8,
                                right: -16,
                                background: 'var(--bg-secondary)',
                                color: 'var(--text-primary)',
                                padding: '8px',
                                borderRadius: '12px',
                                boxShadow: 'var(--shadow-md)',
                                transform: 'rotate(-6deg)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center'
                            }}>
                                <span className="material-icons-outlined" style={{ fontSize: 20, fontWeight: 'bold' }}>add</span>
                            </div>
                        </div>
                    </div>

                    <h3 style={{ fontSize: '24px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '12px' }}>No Collections Yet</h3>
                    <p style={{ color: 'var(--text-secondary)', maxWidth: '420px', margin: '0 auto 32px', lineHeight: 1.6 }}>
                        Collections are automatically created when you insert your first document. Ready to start building your database?
                    </p>

                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                        <button className="btn btn-secondary" style={{ borderRadius: '100px', padding: '12px 32px' }} onClick={() => setShowInsert(true)}>
                            <span>Try inserting one now</span>
                            <span className="material-icons-outlined" style={{ fontSize: 16 }}>arrow_forward</span>
                        </button>
                        <a href="#" style={{ fontSize: '14px', color: 'var(--text-tertiary)', textDecoration: 'underline', textUnderlineOffset: '4px' }}>
                            Read documentation about Collections
                        </a>
                    </div>
                </div>
            ) : (
                <div className="collection-grid">
                    {collections.map(c => (
                        <div className="collection-card" key={c.name}>
                            <div className="collection-name">{c.name}</div>
                            <div className="collection-meta">
                                <span>{c.documentCount.toLocaleString()} docs</span>
                                <span>{c.indexCount} indexes</span>
                                <span>Created {new Date(c.createdAt).toLocaleDateString()}</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ---- Query Builder Tab ----
function QueryBuilderTab({ collections }: { collections: CollectionInfo[] }) {
    const [collection, setCollection] = useState(collections[0]?.name || '');
    const [filter, setFilter] = useState('{}');
    const [projection, setProjection] = useState('');
    const [sort, setSort] = useState('');
    const [limit, setLimit] = useState('50');
    const [results, setResults] = useState<Record<string, unknown>[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [execTime, setExecTime] = useState(0);

    const executeQuery = async () => {
        setLoading(true);
        setError(null);
        const start = Date.now();
        try {
            const body: Record<string, unknown> = { filter: JSON.parse(filter) };
            if (projection) body.projection = JSON.parse(projection);
            if (sort) body.sort = JSON.parse(sort);
            if (limit) body.limit = parseInt(limit);

            const result = await apiPost<{ cursor: { firstBatch: Record<string, unknown>[] } }>(
                `/api/v1/collections/${collection}/find`, body
            );
            setResults(result.cursor.firstBatch);
            setExecTime(Date.now() - start);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Query failed');
        } finally {
            setLoading(false);
        }
    };

    const exportJSON = () => {
        if (!results) return;
        const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${collection}_export.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div className="fade-in">
            <div className="card" style={{ marginBottom: 24 }}>
                <div className="card-header">
                    <div className="card-title">Query Builder</div>
                    {results && <span className="badge badge-success">{results.length} results in {execTime}ms</span>}
                </div>

                <div className="grid-2" style={{ marginBottom: 16 }}>
                    <div className="input-group">
                        <label className="label">Collection</label>
                        <select className="select" value={collection} onChange={e => setCollection(e.target.value)}>
                            {collections.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                            <option value="">-- enter manually --</option>
                        </select>
                    </div>
                    <div className="input-group">
                        <label className="label">Limit</label>
                        <input className="input" type="number" value={limit} onChange={e => setLimit(e.target.value)} />
                    </div>
                </div>

                <div className="input-group">
                    <label className="label">Filter (JSON)</label>
                    <textarea className="textarea" value={filter} onChange={e => setFilter(e.target.value)} rows={3} placeholder='{"field": "value"}' />
                </div>

                <div className="grid-2">
                    <div className="input-group">
                        <label className="label">Projection (optional)</label>
                        <input className="input input-mono" value={projection} onChange={e => setProjection(e.target.value)} placeholder='{"password": 0}' />
                    </div>
                    <div className="input-group">
                        <label className="label">Sort (optional)</label>
                        <input className="input input-mono" value={sort} onChange={e => setSort(e.target.value)} placeholder='{"createdAt": -1}' />
                    </div>
                </div>

                <div style={{ display: 'flex', gap: 12 }}>
                    <button className="btn btn-primary" onClick={executeQuery} disabled={loading || !collection}>
                        {loading ? <div className="spinner" style={{ width: 16, height: 16 }} /> : <Icon name="play" size={16} />}
                        Execute
                    </button>
                    {results && (
                        <button className="btn btn-secondary" onClick={exportJSON}>
                            <Icon name="download" size={16} /> Export JSON
                        </button>
                    )}
                </div>

                {error && <div className="alert alert-error" style={{ marginTop: 16 }}>{error}</div>}
            </div>

            {results && (
                <div className="card">
                    <div className="card-header">
                        <div className="card-title">Results ({results.length} documents)</div>
                    </div>
                    {results.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-state-title">No documents found</div>
                            <div className="empty-state-text">Try adjusting your filter criteria</div>
                        </div>
                    ) : (
                        <div className="table-container" style={{ maxHeight: 500, overflow: 'auto' }}>
                            <table className="table">
                                <thead>
                                    <tr>
                                        {Object.keys(results[0]).map(key => <th key={key}>{key}</th>)}
                                    </tr>
                                </thead>
                                <tbody>
                                    {results.map((doc, i) => (
                                        <tr key={i}>
                                            {Object.values(doc).map((val, j) => (
                                                <td key={j} style={{ fontFamily: 'JetBrains Mono', fontSize: 12 }}>
                                                    {typeof val === 'object' ? JSON.stringify(val) : String(val)}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    {results.length > 0 && (
                        <pre className="json-view" style={{ marginTop: 16, maxHeight: 300, overflow: 'auto' }}>
                            {JSON.stringify(results, null, 2)}
                        </pre>
                    )}
                </div>
            )}
        </div>
    );
}

// ---- Document Explorer Tab ----
function DocumentExplorerTab({ collections }: { collections: CollectionInfo[] }) {
    const { address, isAuthenticated } = useAuth();
    const [scope, setScope] = useState<'my' | 'all'>(isAuthenticated ? 'my' : 'all');
    const [userCollections, setUserCollections] = useState<string[]>([]);
    const [collection, setCollection] = useState(collections[0]?.name || '');
    const [documents, setDocuments] = useState<Record<string, unknown>[]>([]);
    const [selectedDoc, setSelectedDoc] = useState<Record<string, unknown> | null>(null);
    const [editMode, setEditMode] = useState(false);
    const [editJson, setEditJson] = useState('');
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    // Load user's owned collections for scoping
    useEffect(() => {
        if (isAuthenticated && address) {
            apiGet<{ collections: Array<{ name: string }> }>(`/api/v1/user/${address}/collections`)
                .then(res => setUserCollections(res.collections.map(c => c.name)))
                .catch(() => {});
        }
    }, [isAuthenticated, address]);

    const visibleCollections = scope === 'my' && isAuthenticated
        ? collections.filter(c => userCollections.includes(c.name))
        : collections;

    // Reset collection selection when scope changes
    useEffect(() => {
        if (visibleCollections.length > 0 && !visibleCollections.find(c => c.name === collection)) {
            setCollection(visibleCollections[0].name);
        }
    }, [scope, visibleCollections, collection]);

    const loadDocuments = useCallback(async () => {
        if (!collection) return;
        try {
            const result = await apiPost<{ cursor: { firstBatch: Record<string, unknown>[] } }>(
                `/api/v1/collections/${collection}/find`, { filter: {}, limit: 100 }
            );
            setDocuments(result.cursor.firstBatch);
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load' });
        }
    }, [collection]);

    useEffect(() => { loadDocuments(); }, [loadDocuments]);

    const handleUpdate = async () => {
        if (!selectedDoc || !collection) return;
        try {
            const updates = JSON.parse(editJson);
            await apiPost(`/api/v1/collections/${collection}/updateOne`, {
                filter: { _id: selectedDoc._id },
                update: { $set: updates },
            });
            setMessage({ type: 'success', text: 'Document updated' });
            setEditMode(false);
            loadDocuments();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        }
    };

    const handleDelete = async (id: string) => {
        if (!collection) return;
        try {
            await apiPost(`/api/v1/collections/${collection}/deleteOne`, { filter: { _id: id } });
            setMessage({ type: 'success', text: 'Document deleted' });
            setSelectedDoc(null);
            loadDocuments();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Delete failed' });
        }
    };

    return (
        <div className="fade-in">
            {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

            <div className="card" style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div className="input-group" style={{ flex: 1, marginBottom: 0, marginRight: 16 }}>
                        <label className="label">Collection</label>
                        <select className="select" value={collection} onChange={e => { setCollection(e.target.value); setSelectedDoc(null); }}>
                            {visibleCollections.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                        </select>
                    </div>
                    {isAuthenticated && <ScopeToggle scope={scope} setScope={setScope} />}
                </div>
            </div>

            <div className="grid-2">
                <div className="card">
                    <div className="card-header">
                        <div className="card-title">Documents ({documents.length})</div>
                        <button className="btn btn-sm btn-secondary" onClick={loadDocuments}><Icon name="refresh" size={14} /></button>
                    </div>
                    <div style={{ maxHeight: 500, overflow: 'auto' }}>
                        {documents.map((doc, i) => (
                            <div
                                key={i}
                                onClick={() => { setSelectedDoc(doc); setEditMode(false); }}
                                style={{
                                    padding: '10px 12px',
                                    borderBottom: '1px solid var(--border-primary)',
                                    cursor: 'pointer',
                                    background: selectedDoc?._id === doc._id ? 'rgba(131,110,249,0.08)' : 'transparent',
                                    transition: 'background 0.15s',
                                    fontSize: 13,
                                    fontFamily: 'JetBrains Mono',
                                    color: 'var(--text-secondary)',
                                }}
                            >
                                <span style={{ color: 'var(--accent-primary-light)' }}>_id:</span> {String(doc._id).substring(0, 16)}...
                                {doc.name ? <span style={{ marginLeft: 8, color: 'var(--text-tertiary)' }}>| {String(doc.name)}</span> : null}
                            </div>
                        ))}
                    </div>
                </div>

                <div className="card">
                    <div className="card-header">
                        <div className="card-title">Document Detail</div>
                        {selectedDoc && !editMode && (
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button className="btn btn-sm btn-secondary" onClick={() => { setEditMode(true); const { _id, ...rest } = selectedDoc; setEditJson(JSON.stringify(rest, null, 2)); }}>Edit</button>
                                <button className="btn btn-sm btn-danger" onClick={() => handleDelete(String(selectedDoc._id))}>Delete</button>
                            </div>
                        )}
                    </div>
                    {selectedDoc ? (
                        editMode ? (
                            <div>
                                <textarea className="textarea" value={editJson} onChange={e => setEditJson(e.target.value)} rows={12} />
                                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                                    <button className="btn btn-primary btn-sm" onClick={handleUpdate}>Save</button>
                                    <button className="btn btn-secondary btn-sm" onClick={() => setEditMode(false)}>Cancel</button>
                                </div>
                            </div>
                        ) : (
                            <pre className="json-view">{JSON.stringify(selectedDoc, null, 2)}</pre>
                        )
                    ) : (
                        <div className="empty-state">
                            <div className="empty-state-text">Select a document to view details</div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// ---- Index Manager Tab ----
function IndexManagerTab({ collections, onRefresh }: { collections: CollectionInfo[]; onRefresh: () => void }) {
    const { address, isAuthenticated } = useAuth();
    const [scope, setScope] = useState<'my' | 'all'>(isAuthenticated ? 'my' : 'all');
    const [userCollections, setUserCollections] = useState<string[]>([]);
    const [collection, setCollection] = useState(collections[0]?.name || '');
    const [indexes, setIndexes] = useState<IndexInfo[]>([]);
    const [newField, setNewField] = useState('');
    const [unique, setUnique] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    useEffect(() => {
        if (isAuthenticated && address) {
            apiGet<{ collections: Array<{ name: string }> }>(`/api/v1/user/${address}/collections`)
                .then(res => setUserCollections(res.collections.map(c => c.name)))
                .catch(() => {});
        }
    }, [isAuthenticated, address]);

    const visibleCollections = scope === 'my' && isAuthenticated
        ? collections.filter(c => userCollections.includes(c.name))
        : collections;

    useEffect(() => {
        if (visibleCollections.length > 0 && !visibleCollections.find(c => c.name === collection)) {
            setCollection(visibleCollections[0].name);
        }
    }, [scope, visibleCollections, collection]);

    const loadIndexes = useCallback(async () => {
        if (!collection) return;
        try {
            const result = await apiGet<{ indexes: IndexInfo[] }>(`/api/v1/collections/${collection}/indexes`);
            setIndexes(result.indexes);
        } catch (err) {
            setIndexes([]);
        }
    }, [collection]);

    useEffect(() => { loadIndexes(); }, [loadIndexes]);

    const createIndex = async () => {
        if (!newField || !collection) return;
        try {
            await apiPost(`/api/v1/collections/${collection}/createIndex`, { field: newField, unique });
            setMessage({ type: 'success', text: `Index created on "${newField}"` });
            setNewField('');
            loadIndexes();
            onRefresh();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        }
    };

    const dropIndex = async (indexName: string) => {
        try {
            await apiPost(`/api/v1/collections/${collection}/dropIndex`, { indexName });
            setMessage({ type: 'success', text: `Index "${indexName}" dropped` });
            loadIndexes();
            onRefresh();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        }
    };

    return (
        <div className="fade-in">
            {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

            <div className="card" style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <div className="card-title">Create Index</div>
                    {isAuthenticated && <ScopeToggle scope={scope} setScope={setScope} />}
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <div className="input-group" style={{ flex: 1, marginBottom: 0 }}>
                        <label className="label">Collection</label>
                        <select className="select" value={collection} onChange={e => setCollection(e.target.value)}>
                            {visibleCollections.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                        </select>
                    </div>
                    <div className="input-group" style={{ flex: 1, marginBottom: 0 }}>
                        <label className="label">Field Name</label>
                        <input className="input" value={newField} onChange={e => setNewField(e.target.value)} placeholder="email" />
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer', marginBottom: 2 }}>
                        <input type="checkbox" checked={unique} onChange={e => setUnique(e.target.checked)} style={{ accentColor: 'var(--accent-primary)' }} />
                        Unique
                    </label>
                    <button className="btn btn-primary" onClick={createIndex} disabled={!newField}>
                        <Icon name="plus" size={16} /> Create
                    </button>
                </div>
            </div>

            <div className="card">
                <div className="card-header">
                    <div className="card-title">Indexes on {collection || '...'}</div>
                    <span className="badge badge-primary">{indexes.length} indexes</span>
                </div>
                <div className="table-container">
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Field</th>
                                <th>Unique</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {indexes.map(idx => (
                                <tr key={idx.name}>
                                    <td style={{ fontFamily: 'JetBrains Mono', color: 'var(--text-primary)' }}>{idx.name}</td>
                                    <td style={{ fontFamily: 'JetBrains Mono' }}>{idx.field}</td>
                                    <td>{idx.unique ? <span className="badge badge-warning">unique</span> : <span className="badge badge-primary">non-unique</span>}</td>
                                    <td>
                                        {idx.name !== '_id_' && (
                                            <button className="btn btn-sm btn-danger" onClick={() => dropIndex(idx.name)}>
                                                <Icon name="trash" size={14} /> Drop
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}

// ---- Metrics Tab ----
function MetricsTab({ metrics }: { metrics: MetricsData | null }) {
    const { address, isAuthenticated } = useAuth();
    const [userMetrics, setUserMetrics] = useState<UserMetrics | null>(null);

    useEffect(() => {
        if (isAuthenticated && address) {
            apiGet<UserMetrics>(`/api/v1/user/${address}/metrics`).then(setUserMetrics).catch(() => {});
        }
    }, [isAuthenticated, address]);
    if (!metrics) {
        return <div className="loading-center"><div className="spinner" /></div>;
    }

    const commandData = Object.entries(metrics.requests.byCommand).map(([name, count]) => ({ name, count }));

    return (
        <div className="fade-in">
            {/* User-scoped metrics */}
            {isAuthenticated && userMetrics && (
                <div style={{ marginBottom: 24 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent-primary-light)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>My Metrics</div>
                    <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                        <div className="stat-card" style={{ borderLeft: '3px solid var(--accent-primary)' }}>
                            <div className="stat-label">My Collections</div>
                            <div className="stat-value">{userMetrics.collections}</div>
                        </div>
                        <div className="stat-card" style={{ borderLeft: '3px solid var(--accent-secondary)' }}>
                            <div className="stat-label">My Documents</div>
                            <div className="stat-value">{userMetrics.documents.toLocaleString()}</div>
                        </div>
                        <div className="stat-card" style={{ borderLeft: '3px solid var(--accent-tertiary)' }}>
                            <div className="stat-label">My Requests</div>
                            <div className="stat-value">{userMetrics.totalRequests.toLocaleString()}</div>
                        </div>
                        <div className="stat-card" style={{ borderLeft: '3px solid var(--accent-info)' }}>
                            <div className="stat-label">API Keys</div>
                            <div className="stat-value">{userMetrics.apiKeys}</div>
                        </div>
                    </div>
                </div>
            )}

            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-tertiary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Global Metrics</div>
            <div className="stats-grid">
                <div className="stat-card">
                    <div className="stat-label">Total Requests</div>
                    <div className="stat-value">{metrics.requests.total.toLocaleString()}</div>
                </div>
                <div className="stat-card">
                    <div className="stat-label">Avg Latency</div>
                    <div className="stat-value">{metrics.latency.avg.toFixed(1)}<span style={{ fontSize: 16, opacity: 0.6 }}>ms</span></div>
                </div>
                <div className="stat-card">
                    <div className="stat-label">P95 Latency</div>
                    <div className="stat-value">{metrics.latency.p95.toFixed(1)}<span style={{ fontSize: 16, opacity: 0.6 }}>ms</span></div>
                </div>
                <div className="stat-card">
                    <div className="stat-label">Error Rate</div>
                    <div className="stat-value" style={{ color: metrics.errors.total > 0 ? 'var(--accent-error)' : undefined }}>
                        {metrics.requests.total > 0 ? ((metrics.errors.total / metrics.requests.total) * 100).toFixed(2) : '0.00'}%
                    </div>
                </div>
            </div>

            <div className="grid-2">
                <div className="card">
                    <div className="card-header">
                        <div className="card-title">Requests by Command</div>
                    </div>
                    {commandData.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-state-text">No requests recorded yet</div>
                        </div>
                    ) : (
                        <div>
                            {commandData.sort((a, b) => b.count - a.count).map(item => (
                                <div key={item.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border-primary)' }}>
                                    <span style={{ fontFamily: 'JetBrains Mono', fontSize: 13, width: 120, color: 'var(--text-primary)' }}>{item.name}</span>
                                    <div style={{ flex: 1, background: 'var(--bg-tertiary)', borderRadius: 4, height: 24, overflow: 'hidden' }}>
                                        <div style={{
                                            width: `${Math.max(4, (item.count / Math.max(1, metrics.requests.total)) * 100)}%`,
                                            height: '100%',
                                            background: 'var(--gradient-primary)',
                                            borderRadius: 4,
                                            transition: 'width 0.5s ease',
                                        }} />
                                    </div>
                                    <span style={{ fontFamily: 'JetBrains Mono', fontSize: 13, width: 60, textAlign: 'right' }}>{item.count}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="card">
                    <div className="card-header">
                        <div className="card-title">Protocol Distribution</div>
                    </div>
                    <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
                        <div style={{ flex: 1, padding: 20, background: 'rgba(131,110,249,0.05)', borderRadius: 'var(--radius-md)', textAlign: 'center' }}>
                            <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--accent-primary-light)' }}>{metrics.requests.byProtocol.http}</div>
                            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4, textTransform: 'uppercase', letterSpacing: 1 }}>HTTP</div>
                        </div>
                        <div style={{ flex: 1, padding: 20, background: 'rgba(0,212,170,0.05)', borderRadius: 'var(--radius-md)', textAlign: 'center' }}>
                            <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--accent-secondary)' }}>{metrics.requests.byProtocol.wire}</div>
                            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4, textTransform: 'uppercase', letterSpacing: 1 }}>Wire Protocol</div>
                        </div>
                    </div>

                    <div style={{ marginTop: 24 }}>
                        <div className="card-title" style={{ marginBottom: 12 }}>Storage</div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-primary)' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>Key Count</span>
                            <span style={{ fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{metrics.storage.keyCount.toLocaleString()}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-primary)' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>Est. Size</span>
                            <span style={{ fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{formatBytes(metrics.storage.estimatedSizeBytes)}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
                            <span style={{ color: 'var(--text-secondary)' }}>Uptime</span>
                            <span style={{ fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{formatUptime(metrics.uptime)}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ---- Protocols Tab ----
interface ProtocolInfo {
    name: string;
    enabled: boolean;
    port: number;
    connections: number;
    connectionString: string;
}

function ProtocolsTab() {
    const [protocols, setProtocols] = useState<ProtocolInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [toggling, setToggling] = useState<string | null>(null);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    const colorMap: Record<string, string> = {
        mongodb: '#00ed64',
        postgresql: '#336791',
        mysql: '#f29111',
        redis: '#dc382d',
        http: '#00d4aa',
    };

    const descMap: Record<string, string> = {
        mongodb: 'MongoDB Wire Protocol — Connect with mongosh, Mongoose, native drivers',
        postgresql: 'PostgreSQL v3 Wire Protocol — Connect with psql, Prisma, Sequelize, Knex',
        mysql: 'MySQL Text Protocol — Connect with mysql-cli, mysql2, TypeORM',
        redis: 'Redis RESP Protocol — Connect with redis-cli, ioredis. Pub/Sub via Monad events',
        http: 'HTTP REST API — Always enabled. JSON endpoints for all operations',
    };

    const loadProtocols = useCallback(async () => {
        try {
            const res = await apiGet<{ protocols: ProtocolInfo[] }>('/api/v1/protocols');
            setProtocols(res.protocols || []);
        } catch {
            // Fallback: use health endpoint
            try {
                const health = await apiGet<{ protocols?: ProtocolInfo[] }>('/health');
                setProtocols(health.protocols || []);
            } catch { /* ignore */ }
        }
        setLoading(false);
    }, []);

    useEffect(() => { loadProtocols(); }, [loadProtocols]);

    const toggleProtocol = async (name: string, currentlyEnabled: boolean) => {
        if (name === 'http') return; // Can't disable HTTP
        setToggling(name);
        setMessage(null);
        try {
            const action = currentlyEnabled ? 'disable' : 'enable';
            await apiPost(`/api/v1/protocols/${name}/${action}`, {});
            setMessage({ type: 'success', text: `${name} ${action}d successfully` });
            await loadProtocols();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        } finally {
            setToggling(null);
        }
    };

    if (loading) return <div className="loading-center"><div className="spinner" /></div>;

    return (
        <div className="fade-in">
            {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

            <div style={{ display: 'grid', gap: 16 }}>
                {protocols.map(p => (
                    <div key={p.name} className="card" style={{
                        borderLeft: `4px solid ${colorMap[p.name] || 'var(--border-primary)'}`,
                        opacity: p.enabled ? 1 : 0.6,
                        transition: 'opacity 0.3s',
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                                    <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'capitalize' }}>
                                        {p.name}
                                    </span>
                                    <span className={`badge ${p.enabled ? 'badge-success' : 'badge-warning'}`}>
                                        {p.enabled ? 'ENABLED' : 'DISABLED'}
                                    </span>
                                    {p.enabled && p.connections > 0 && (
                                        <span className="badge badge-primary">{p.connections} connections</span>
                                    )}
                                </div>
                                <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 8 }}>
                                    {descMap[p.name] || 'Custom protocol'}
                                </div>
                                {p.enabled && (
                                    <div style={{
                                        display: 'inline-block',
                                        padding: '6px 12px',
                                        background: 'var(--bg-tertiary)',
                                        borderRadius: 'var(--radius-sm)',
                                        fontFamily: 'JetBrains Mono',
                                        fontSize: 12,
                                        color: 'var(--text-secondary)',
                                    }}>
                                        {p.connectionString}
                                    </div>
                                )}
                            </div>
                            <div>
                                {p.name !== 'http' && (
                                    <button
                                        className={`btn ${p.enabled ? 'btn-danger' : 'btn-primary'} btn-sm`}
                                        onClick={() => toggleProtocol(p.name, p.enabled)}
                                        disabled={toggling === p.name}
                                        style={{ minWidth: 90 }}
                                    >
                                        {toggling === p.name
                                            ? <div className="spinner" style={{ width: 14, height: 14 }} />
                                            : p.enabled ? 'Disable' : 'Enable'}
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            <div className="card" style={{ marginTop: 24 }}>
                <div className="card-header">
                    <div className="card-title">Multi-Protocol Architecture</div>
                    <span className="badge badge-primary">All Monad-backed</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.7, marginTop: 8 }}>
                    All protocols share the same DocumentStore and Monad smart contract backend.
                    Data written via PostgreSQL is immediately readable via MongoDB, Redis, or HTTP.
                    Enable/disable protocols at runtime — each runs on its own port.
                </div>
            </div>
        </div>
    );
}

// ---- Privacy & ACL Tab ----
function PrivacyTab({ collections }: { collections: CollectionInfo[] }) {
    const [selectedCollection, setSelectedCollection] = useState(collections[0]?.name || '');
    const [storageMode, setStorageMode] = useState<string>('public');
    const [addresses, setAddresses] = useState<string[]>([]);
    const [newAddress, setNewAddress] = useState('');
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [switching, setSwitching] = useState(false);

    const loadData = useCallback(async () => {
        if (!selectedCollection) return;
        try {
            const privacy = await apiGet<{ privacy: { mode: string; whitelistedAddresses: string[] } | null }>(`/api/v1/collections/${selectedCollection}/privacy`);
            setStorageMode(privacy.privacy?.mode || 'public');
            setAddresses(privacy.privacy?.whitelistedAddresses || []);
        } catch {
            // Fallback: try global health endpoint
            try {
                const health = await apiGet<{ storageMode?: string }>('/health');
                setStorageMode(health.storageMode || 'public');
            } catch { /* ignore */ }
        }
    }, [selectedCollection]);

    useEffect(() => { loadData(); }, [loadData]);

    const handleModeSwitch = async (mode: string) => {
        if (!selectedCollection || mode === storageMode) return;
        setSwitching(true);
        try {
            await apiPost(`/api/v1/collections/${selectedCollection}/privacy`, { mode });
            setMessage({ type: 'success', text: `${selectedCollection} switched to ${mode}` });
            setStorageMode(mode);
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to switch' });
        } finally {
            setSwitching(false);
        }
    };

    const addAddress = async () => {
        if (!newAddress || !newAddress.startsWith('0x')) {
            setMessage({ type: 'error', text: 'Enter a valid Ethereum address (0x...)' });
            return;
        }
        try {
            await apiPost(`/api/v1/collections/${selectedCollection}/whitelist`, { address: newAddress, action: 'add' });
            setMessage({ type: 'success', text: `Address ${newAddress.substring(0, 10)}... added to ${selectedCollection}` });
            setNewAddress('');
            loadData();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        }
    };

    const removeAddress = async (addr: string) => {
        try {
            await apiPost(`/api/v1/collections/${selectedCollection}/whitelist`, { address: addr, action: 'remove' });
            setMessage({ type: 'success', text: `Address removed from ${selectedCollection}` });
            loadData();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        }
    };

    return (
        <div className="fade-in">
            {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

            {/* Storage Mode */}
            <div className="card" style={{ marginBottom: 24 }}>
                <div className="card-header">
                    <div className="card-title">Collection Privacy</div>
                    <span className={`badge ${storageMode === 'private' ? 'badge-warning' : 'badge-success'}`}>
                        {storageMode.toUpperCase()}
                    </span>
                </div>

                {/* Collection Selector */}
                <div className="input-group" style={{ marginBottom: 16 }}>
                    <label className="label">Select Collection</label>
                    <select className="select" value={selectedCollection} onChange={e => setSelectedCollection(e.target.value)}>
                        {collections.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
                    <div style={{
                        padding: 20,
                        borderRadius: 'var(--radius-md)',
                        border: `2px solid ${storageMode === 'public' ? 'var(--accent-secondary)' : 'var(--border-primary)'}`,
                        background: storageMode === 'public' ? 'rgba(0,212,170,0.05)' : 'transparent',
                        cursor: 'pointer',
                    }}
                    onClick={() => handleModeSwitch('public')}
                    >
                        <div style={{ fontWeight: 700, marginBottom: 6, color: storageMode === 'public' ? 'var(--accent-secondary)' : 'var(--text-tertiary)' }}>Public</div>
                        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                            Data stored on-chain in plaintext. Readable by anyone. Fast and transparent.
                        </div>
                    </div>
                    <div style={{
                        padding: 20,
                        borderRadius: 'var(--radius-md)',
                        border: `2px solid ${storageMode === 'private' ? 'var(--accent-tertiary)' : 'var(--border-primary)'}`,
                        background: storageMode === 'private' ? 'rgba(255,107,157,0.05)' : 'transparent',
                        cursor: 'pointer',
                    }}
                    onClick={() => handleModeSwitch('private')}
                    >
                        <div style={{ fontWeight: 700, marginBottom: 6, color: storageMode === 'private' ? 'var(--accent-tertiary)' : 'var(--text-tertiary)' }}>Private (Encrypted)</div>
                        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                            AES-256-GCM encrypted. Only owner + whitelisted addresses can access. Keys shared via ECDH.
                        </div>
                    </div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 12 }}>
                    Click a mode to switch. No server restart needed — privacy is configured per-collection.
                </div>
            </div>

            {/* Whitelist Management */}
            <div className="card">
                <div className="card-header">
                    <div className="card-title">Whitelist for &ldquo;{selectedCollection}&rdquo;</div>
                    <span className="badge badge-primary">{addresses.length} addresses</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16 }}>
                    Whitelisted addresses can read/write data in this private collection.
                    The owner address (gas station) is always authorized.
                </div>

                <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                    <input
                        className="input input-mono"
                        style={{ flex: 1 }}
                        value={newAddress}
                        onChange={e => setNewAddress(e.target.value)}
                        placeholder="0x... Ethereum address"
                    />
                    <button className="btn btn-primary" onClick={addAddress} disabled={!newAddress}>
                        <Icon name="plus" size={16} /> Add
                    </button>
                </div>

                {addresses.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-state-text">No addresses whitelisted yet</div>
                    </div>
                ) : (
                    <div className="table-container">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>#</th>
                                    <th>Address</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {addresses.map((addr, i) => (
                                    <tr key={addr}>
                                        <td>{i + 1}</td>
                                        <td style={{ fontFamily: 'JetBrains Mono', fontSize: 13 }}>{addr}</td>
                                        <td>
                                            <button className="btn btn-sm btn-danger" onClick={() => removeAddress(addr)}>
                                                <Icon name="trash" size={14} /> Remove
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Encryption Info */}
            <div className="card" style={{ marginTop: 24 }}>
                <div className="card-header">
                    <div className="card-title">Encryption Details</div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginTop: 12 }}>
                    <div style={{ padding: 16, background: 'rgba(131,110,249,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(131,110,249,0.1)' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: 'var(--accent-primary-light)' }}>AES-256-GCM</div>
                        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>Authenticated encryption. Every value is encrypted with a unique IV. Tamper detection via auth tag.</div>
                    </div>
                    <div style={{ padding: 16, background: 'rgba(0,212,170,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(0,212,170,0.1)' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: 'var(--accent-secondary)' }}>HKDF Key Derivation</div>
                        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>AES key derived from owner's Ethereum private key via HMAC-SHA256 (HKDF). Never stored on-chain.</div>
                    </div>
                    <div style={{ padding: 16, background: 'rgba(255,107,157,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(255,107,157,0.1)' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: 'var(--accent-tertiary)' }}>ECDH Key Sharing</div>
                        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>AES key shared with whitelisted addresses via Elliptic Curve Diffie-Hellman. Encrypted key share stored on-chain.</div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ════════════════════════════════════════════════════════
// Deploy & Gas Station Tab
// ════════════════════════════════════════════════════════

function DeployTab() {
    const { address, isAuthenticated } = useAuth();
    const { isConnected } = useAccount();
    const factoryAddress = process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
    const { state: deployState, deployPrivateStore, getGasStationInfo, getDeployedStores, reset } = useContractDeployer(factoryAddress);
    const [gasStationAddr, setGasStationAddr] = useState('');
    const [gasInfo, setGasInfo] = useState<GasStationInfo | null>(null);
    const [deployedContracts, setDeployedContracts] = useState<Array<{ contractAddress: string; contractType: string; createdAt: number }>>([]);
    const [loadingContracts, setLoadingContracts] = useState(true);

    // Load deployed contracts from server
    useEffect(() => {
        if (isAuthenticated && address) {
            apiGet<{ contracts: Array<{ contractAddress: string; contractType: string; createdAt: number }> }>('/api/v1/deploy/contracts')
                .then(res => setDeployedContracts(res.contracts))
                .catch(() => {})
                .finally(() => setLoadingContracts(false));
        } else {
            setLoadingContracts(false);
        }
    }, [isAuthenticated, address]);

    // Load gas station info
    const refreshGasInfo = useCallback(async (addr: string) => {
        if (!addr) return;
        try {
            const res = await apiGet<GasStationInfo>(`/api/v1/deploy/gas-station/${addr}/balance`);
            setGasInfo(res);
        } catch {
            // Try via the hook if server fails
            const info = await getGasStationInfo(addr);
            setGasInfo(info);
        }
    }, [getGasStationInfo]);

    const handleDeploy = async () => {
        if (!gasStationAddr) return;
        const result = await deployPrivateStore(gasStationAddr);
        if (result) {
            // Refresh contracts list
            try {
                const res = await apiGet<{ contracts: Array<{ contractAddress: string; contractType: string; createdAt: number }> }>('/api/v1/deploy/contracts');
                setDeployedContracts(res.contracts);
            } catch {}
        }
    };

    const stepLabels: Record<string, { label: string; color: string }> = {
        idle: { label: 'Ready', color: 'var(--text-tertiary)' },
        estimating: { label: 'Estimating gas...', color: 'var(--accent-info)' },
        deploying: { label: 'Awaiting wallet signature...', color: 'var(--accent-warning)' },
        confirming: { label: 'Confirming on-chain...', color: 'var(--accent-primary-light)' },
        registering: { label: 'Registering with server...', color: 'var(--accent-primary-light)' },
        done: { label: 'Deployed successfully!', color: 'var(--accent-success)' },
        error: { label: 'Deployment failed', color: 'var(--accent-error)' },
    };

    if (!isAuthenticated || !isConnected) {
        return (
            <div className="fade-in">
                <div className="card">
                    <div className="empty-state">
                        <div className="empty-state-title">Connect Wallet</div>
                        <div className="empty-state-text">Connect your wallet and sign in to deploy contracts and manage gas stations.</div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="fade-in">
            {/* Deployment Wizard */}
            <div className="card" style={{ marginBottom: 24 }}>
                <div className="card-header">
                    <div className="card-title">Deploy Private Store</div>
                    <span className="badge badge-primary">via Factory Contract</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20, lineHeight: 1.6 }}>
                    Deploy a new <code style={{ background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4 }}>PlugPortPrivateStore</code> contract
                    for encrypted, access-controlled data. Each private collection uses its own contract instance.
                </div>

                {/* Step 1: Gas station address */}
                <div className="input-group" style={{ marginBottom: 16 }}>
                    <label className="label">Gas Station Address</label>
                    <div style={{ display: 'flex', gap: 12 }}>
                        <input
                            className="input"
                            value={gasStationAddr}
                            onChange={e => setGasStationAddr(e.target.value)}
                            placeholder="0x... (wallet that pays for gas)"
                            style={{ flex: 1 }}
                        />
                        <button className="btn btn-secondary btn-sm" onClick={() => refreshGasInfo(gasStationAddr)} disabled={!gasStationAddr}>
                            Check Balance
                        </button>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 6 }}>
                        The gas station is a wallet address that pays for on-chain operations. Use your own address or a dedicated gas wallet.
                    </div>
                </div>

                {/* Gas Station Info */}
                {gasInfo && (
                    <div className="gas-station-panel" style={{
                        padding: 16,
                        borderRadius: 'var(--radius-md)',
                        background: gasInfo.isLow ? 'rgba(255,107,157,0.05)' : 'rgba(0,212,170,0.05)',
                        border: `1px solid ${gasInfo.isLow ? 'rgba(255,107,157,0.2)' : 'rgba(0,212,170,0.2)'}`,
                        marginBottom: 20,
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: gasInfo.isLow ? 'var(--accent-tertiary)' : 'var(--accent-secondary)' }}>
                                Gas Station Balance
                            </div>
                            {gasInfo.isLow && <span className="badge badge-warning">Low Balance</span>}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
                            <div>
                                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 4 }}>Balance</div>
                                <div style={{ fontSize: 20, fontWeight: 800, fontFamily: 'JetBrains Mono', color: 'var(--text-primary)' }}>
                                    {parseFloat(gasInfo.balance).toFixed(4)} <span style={{ fontSize: 12, opacity: 0.6 }}>MON</span>
                                </div>
                            </div>
                            <div>
                                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 4 }}>Est. Operations</div>
                                <div style={{ fontSize: 20, fontWeight: 800, fontFamily: 'JetBrains Mono', color: 'var(--text-primary)' }}>
                                    {gasInfo.estimatedOps.toLocaleString()}
                                </div>
                            </div>
                            <div>
                                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 4 }}>Address</div>
                                <div style={{ fontSize: 13, fontFamily: 'JetBrains Mono', color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                                    {gasInfo.address.substring(0, 10)}...{gasInfo.address.substring(38)}
                                </div>
                            </div>
                        </div>
                        {gasInfo.isLow && (
                            <div style={{ fontSize: 12, color: 'var(--accent-tertiary)', marginTop: 12, padding: '8px 12px', background: 'rgba(255,107,157,0.08)', borderRadius: 'var(--radius-sm)' }}>
                                ⚠️ Balance is below 0.1 MON. Top up your gas station to ensure uninterrupted operations.
                            </div>
                        )}
                    </div>
                )}

                {/* Deploy button + status */}
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <button
                        className="btn btn-primary"
                        onClick={handleDeploy}
                        disabled={!gasStationAddr || deployState.step === 'deploying' || deployState.step === 'confirming' || deployState.step === 'registering'}
                    >
                        {deployState.step === 'idle' || deployState.step === 'done' || deployState.step === 'error'
                            ? '🚀 Deploy Contract'
                            : '⏳ Deploying...'
                        }
                    </button>
                    {deployState.step !== 'idle' && (
                        <span style={{ fontSize: 13, color: stepLabels[deployState.step]?.color || 'var(--text-tertiary)' }}>
                            {stepLabels[deployState.step]?.label}
                        </span>
                    )}
                    {deployState.step === 'done' && (
                        <button className="btn btn-secondary btn-sm" onClick={reset}>Deploy Another</button>
                    )}
                </div>

                {/* Deployment result */}
                {deployState.step === 'done' && deployState.contractAddress && (
                    <div style={{ marginTop: 16, padding: 16, background: 'rgba(0,212,170,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(0,212,170,0.2)' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent-success)', marginBottom: 8 }}>✅ Contract Deployed</div>
                        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
                            <strong>Address:</strong> <code style={{ fontFamily: 'JetBrains Mono', background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4 }}>{deployState.contractAddress}</code>
                        </div>
                        {deployState.txHash && (
                            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                                <strong>Tx Hash:</strong> <code style={{ fontFamily: 'JetBrains Mono', background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4 }}>{deployState.txHash.substring(0, 20)}...</code>
                            </div>
                        )}
                    </div>
                )}

                {deployState.step === 'error' && deployState.error && (
                    <div className="alert alert-error" style={{ marginTop: 16 }}>{deployState.error}</div>
                )}
            </div>

            {/* Deployed Contracts */}
            <div className="card">
                <div className="card-header">
                    <div className="card-title">My Deployed Contracts</div>
                    <span className="badge badge-primary">{deployedContracts.length} contracts</span>
                </div>
                {loadingContracts ? (
                    <div className="loading-center"><div className="spinner" /></div>
                ) : deployedContracts.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-state-text">No contracts deployed yet. Use the wizard above to deploy your first private store.</div>
                    </div>
                ) : (
                    <div className="table-container">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Contract Address</th>
                                    <th>Type</th>
                                    <th>Deployed</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {deployedContracts.map(c => (
                                    <tr key={c.contractAddress}>
                                        <td style={{ fontFamily: 'JetBrains Mono', color: 'var(--text-primary)', fontSize: 12 }}>
                                            {c.contractAddress.substring(0, 14)}...{c.contractAddress.substring(38)}
                                        </td>
                                        <td><span className={`badge ${c.contractType === 'privateStore' ? 'badge-warning' : 'badge-primary'}`}>{c.contractType}</span></td>
                                        <td style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{new Date(c.createdAt).toLocaleDateString()}</td>
                                        <td>
                                            <button
                                                className="btn btn-sm btn-secondary"
                                                onClick={() => { setGasStationAddr(c.contractAddress); refreshGasInfo(c.contractAddress); }}
                                            >
                                                Check Gas
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

// ---- Helpers ----
function formatUptime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
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

// ════════════════════════════════════════════════════════
// API Keys & Analytics Tab
// ════════════════════════════════════════════════════════

function ApiKeysTab() {
    const { address, isAuthenticated, authMethod } = useAuth();
    const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [newLabel, setNewLabel] = useState('');
    const [newPermissions, setNewPermissions] = useState<string[]>(['all']);
    const [generatedKey, setGeneratedKey] = useState<string | null>(null);
    const [expandedKey, setExpandedKey] = useState<string | null>(null);
    const [keyAnalytics, setKeyAnalytics] = useState<KeyAnalytics | null>(null);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    const loadKeys = useCallback(async () => {
        try {
            const res = await apiGet<{ keys: ApiKeyInfo[] }>('/api/v1/keys');
            setKeys(res.keys || []);
        } catch { /* ignore */ }
        setLoading(false);
    }, []);

    useEffect(() => {
        if (isAuthenticated) loadKeys();
        else setLoading(false);
    }, [isAuthenticated, loadKeys]);

    const handleGenerate = async () => {
        if (!newLabel.trim()) {
            setMessage({ type: 'error', text: 'Label is required' });
            return;
        }
        try {
            const res = await apiPost<{ apiKey: string; metadata: ApiKeyInfo }>('/api/v1/keys/generate', {
                label: newLabel,
                permissions: newPermissions,
            });
            setGeneratedKey(res.apiKey);
            setMessage({ type: 'success', text: 'API key generated! Copy it now — it won\'t be shown again.' });
            setNewLabel('');
            loadKeys();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        }
    };

    const handleRevoke = async (hash: string) => {
        try {
            await apiDelete(`/api/v1/keys/${hash}`);
            setMessage({ type: 'success', text: 'Key revoked' });
            loadKeys();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        }
    };

    const handleRotate = async (hash: string) => {
        try {
            const res = await apiPost<{ apiKey: string }>(`/api/v1/keys/${hash}/rotate`, {});
            setGeneratedKey(res.apiKey);
            setMessage({ type: 'success', text: 'Key rotated! Copy the new key.' });
            loadKeys();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        }
    };

    const loadAnalytics = async (hash: string) => {
        if (expandedKey === hash) {
            setExpandedKey(null);
            setKeyAnalytics(null);
            return;
        }
        try {
            const res = await apiGet<{ analytics: KeyAnalytics }>(`/api/v1/keys/${hash}/analytics?days=7`);
            setKeyAnalytics(res.analytics);
            setExpandedKey(hash);
        } catch { /* ignore */ }
    };

    if (!isAuthenticated || authMethod !== 'wallet') {
        return (
            <div className="fade-in">
                <div className="card">
                    <div className="empty-state">
                        <Icon name="wallet" size={48} />
                        <div className="empty-state-title" style={{ marginTop: 16 }}>Connect Your Wallet</div>
                        <div className="empty-state-text">Connect your wallet and sign in with SIWE to generate and manage API keys.</div>
                    </div>
                </div>
            </div>
        );
    }

    if (loading) return <div className="loading-center"><div className="spinner" /></div>;

    return (
        <div className="fade-in">
            {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

            {/* Generated key display */}
            {generatedKey && (
                <div className="alert alert-success" style={{ fontFamily: 'JetBrains Mono', fontSize: 13, flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ fontWeight: 700 }}>Your API Key (copy now — shown only once):</div>
                    <div style={{ display: 'flex', gap: 8, width: '100%' }}>
                        <code style={{ flex: 1, background: 'rgba(0,0,0,0.2)', padding: '8px 12px', borderRadius: 6, wordBreak: 'break-all' }}>
                            {generatedKey}
                        </code>
                        <button className="btn btn-sm btn-secondary" onClick={() => { navigator.clipboard.writeText(generatedKey); }}>Copy</button>
                    </div>
                    <button className="btn btn-sm" style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', padding: 0, marginTop: 4, fontSize: 11 }} onClick={() => setGeneratedKey(null)}>Dismiss</button>
                </div>
            )}

            {/* Generate new key */}
            <div className="card" style={{ marginBottom: 24 }}>
                <div className="card-header">
                    <div className="card-title">Generate API Key</div>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                        <label className="label">Label</label>
                        <input
                            className="input"
                            value={newLabel}
                            onChange={e => setNewLabel(e.target.value)}
                            placeholder="e.g., my-app-prod"
                        />
                    </div>
                    <div style={{ minWidth: 180 }}>
                        <label className="label">Permissions</label>
                        <select className="select" value={newPermissions[0]} onChange={e => setNewPermissions([e.target.value])}>
                            <option value="all">All (read + write + admin)</option>
                            <option value="read">Read Only</option>
                            <option value="write">Read + Write</option>
                            <option value="admin">Admin</option>
                        </select>
                    </div>
                    <button className="btn btn-primary" onClick={handleGenerate} disabled={!newLabel.trim()}>
                        <Icon name="key" size={16} /> Generate
                    </button>
                </div>
            </div>

            {/* Active keys */}
            <div style={{ display: 'grid', gap: 16 }}>
                {keys.length === 0 ? (
                    <div className="card">
                        <div className="empty-state">
                            <div className="empty-state-title">No API Keys</div>
                            <div className="empty-state-text">Generate your first API key to start using PlugPort programmatically.</div>
                        </div>
                    </div>
                ) : (
                    keys.map(k => (
                        <div key={k.hash} className="card">
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                <div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                                        <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{k.label}</span>
                                        <span className="badge badge-success">ACTIVE</span>
                                        {k.permissions.map(p => (
                                            <span key={p} className="badge badge-primary" style={{ fontSize: 10 }}>{p}</span>
                                        ))}
                                    </div>
                                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                                        Hash: <code style={{ fontFamily: 'JetBrains Mono' }}>{k.hash.substring(0, 16)}...</code>
                                        {' · '}Created: {new Date(k.createdAt).toLocaleDateString()}
                                    </div>
                                </div>
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button className="btn btn-sm btn-secondary" onClick={() => loadAnalytics(k.hash)}>
                                        <Icon name="chart" size={14} /> {expandedKey === k.hash ? 'Hide' : 'Analytics'}
                                    </button>
                                    <button className="btn btn-sm btn-secondary" onClick={() => handleRotate(k.hash)}>Rotate</button>
                                    <button className="btn btn-sm btn-danger" onClick={() => handleRevoke(k.hash)}>Revoke</button>
                                </div>
                            </div>

                            {/* Per-key analytics (expandable) */}
                            {expandedKey === k.hash && keyAnalytics && (
                                <div style={{ marginTop: 20, borderTop: '1px solid var(--border-primary)', paddingTop: 20 }}>
                                    <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                                        <div className="stat-card">
                                            <div className="stat-label">Total Requests</div>
                                            <div className="stat-value" style={{ fontSize: 24 }}>{keyAnalytics.totalRequests.toLocaleString()}</div>
                                        </div>
                                        <div className="stat-card">
                                            <div className="stat-label">Avg Latency</div>
                                            <div className="stat-value" style={{ fontSize: 24 }}>
                                                {keyAnalytics.daily.length > 0
                                                    ? `${(keyAnalytics.daily.reduce((s, d) => s + d.avgLatencyMs, 0) / Math.max(1, keyAnalytics.daily.filter(d => d.requests > 0).length)).toFixed(1)}ms`
                                                    : '—'}
                                            </div>
                                        </div>
                                        <div className="stat-card">
                                            <div className="stat-label">Error Rate</div>
                                            <div className="stat-value" style={{ fontSize: 24 }}>
                                                {keyAnalytics.daily.length > 0
                                                    ? `${(keyAnalytics.daily.reduce((s, d) => s + d.errorRate, 0) / Math.max(1, keyAnalytics.daily.filter(d => d.requests > 0).length) * 100).toFixed(1)}%`
                                                    : '—'}
                                            </div>
                                        </div>
                                        <div className="stat-card">
                                            <div className="stat-label">Collections</div>
                                            <div className="stat-value" style={{ fontSize: 24 }}>{Object.keys(keyAnalytics.collections).length}</div>
                                        </div>
                                    </div>

                                    {/* Operation breakdown */}
                                    {Object.keys(keyAnalytics.operations).length > 0 && (
                                        <div style={{ marginTop: 16 }}>
                                            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: 'var(--text-primary)' }}>By Operation</div>
                                            {(() => {
                                                const maxOps = Math.max(...Object.values(keyAnalytics.operations));
                                                return Object.entries(keyAnalytics.operations)
                                                    .sort(([, a], [, b]) => b - a)
                                                    .map(([op, count]) => (
                                                        <div key={op} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                                                            <span style={{ width: 70, fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'JetBrains Mono' }}>{op}</span>
                                                            <div style={{ flex: 1, height: 20, background: 'var(--bg-input)', borderRadius: 4, overflow: 'hidden' }}>
                                                                <div style={{ height: '100%', width: `${(count / maxOps) * 100}%`, background: 'var(--gradient-primary)', borderRadius: 4, transition: 'width 0.5s' }} />
                                                            </div>
                                                            <span style={{ width: 60, textAlign: 'right', fontSize: 12, fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{count.toLocaleString()}</span>
                                                        </div>
                                                    ));
                                            })()}
                                        </div>
                                    )}

                                    {/* Top collections */}
                                    {Object.keys(keyAnalytics.collections).length > 0 && (
                                        <div style={{ marginTop: 16 }}>
                                            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: 'var(--text-primary)' }}>Top Collections</div>
                                            <div className="table-container">
                                                <table className="table">
                                                    <thead><tr><th>Collection</th><th>Requests</th></tr></thead>
                                                    <tbody>
                                                        {Object.entries(keyAnalytics.collections)
                                                            .sort(([, a], [, b]) => b - a)
                                                            .slice(0, 10)
                                                            .map(([col, count]) => (
                                                                <tr key={col}>
                                                                    <td style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{col}</td>
                                                                    <td style={{ fontFamily: 'JetBrains Mono' }}>{count.toLocaleString()}</td>
                                                                </tr>
                                                            ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>

            {/* Usage instructions */}
            <div className="card" style={{ marginTop: 24 }}>
                <div className="card-header">
                    <div className="card-title">Using Your API Key</div>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.7 }}>
                    Add your API key to your project&apos;s <code style={{ background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4 }}>.env</code> file:
                </div>
                <pre className="json-view" style={{ marginTop: 12 }}>
{`# .env
PLUGPORT_API_KEY=pp_test_your_key_here
PLUGPORT_URL=http://localhost:8080

# Usage with curl:
curl -X POST http://localhost:8080/api/v1/collections/users/find \\
  -H "x-api-key: pp_test_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{"filter": {}}'`}
                </pre>
            </div>
        </div>
    );
}
