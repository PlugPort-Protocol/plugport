'use client';

import { useState, useEffect, useCallback } from 'react';
import { useApi, apiPost, apiGet } from '@/lib/api';

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

type TabId = 'overview' | 'collections' | 'query' | 'indexes' | 'metrics' | 'explorer';

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
        { id: 'query', label: 'Query Builder', icon: 'search', section: 'Data' },
        { id: 'explorer', label: 'Document Explorer', icon: 'eye', section: 'Data' },
        { id: 'indexes', label: 'Index Manager', icon: 'index', section: 'Performance' },
        { id: 'metrics', label: 'Metrics', icon: 'chart', section: 'Performance' },
    ];

    const sections = [...new Set(navItems.map(i => i.section))];

    return (
        <nav className="sidebar">
            <div className="sidebar-brand">
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <img src="/logo.png" alt="PlugPort Logo" width={32} height={32} style={{ borderRadius: 6 }} />
                    <h1>PlugPort</h1>
                </div>
                <p>MonadDb Document Store</p>
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
                <div className="status-text">
                    <span className="status-dot" style={{ background: health ? '#00d4aa' : '#ff4757' }} />
                    {health ? 'Connected' : 'Disconnected'}
                </div>
            </div>
        </nav>
    );
}

// ---- Overview Tab ----
function OverviewTab({ collections, metrics }: { collections: CollectionInfo[]; metrics: MetricsData | null }) {
    const totalDocs = collections.reduce((s, c) => s + c.documentCount, 0);
    const totalIndexes = collections.reduce((s, c) => s + c.indexCount, 0);

    return (
        <div className="fade-in">
            <div className="stats-grid">
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
                <div className="card">
                    <div className="empty-state">
                        <Icon name="database" size={48} />
                        <div className="empty-state-title">No Collections</div>
                        <div className="empty-state-text">Collections are automatically created when you insert your first document. Try inserting one above!</div>
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
    const [collection, setCollection] = useState(collections[0]?.name || '');
    const [documents, setDocuments] = useState<Record<string, unknown>[]>([]);
    const [selectedDoc, setSelectedDoc] = useState<Record<string, unknown> | null>(null);
    const [editMode, setEditMode] = useState(false);
    const [editJson, setEditJson] = useState('');
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Update failed' });
        }
    };

    const handleDelete = async (docId: string) => {
        if (!collection) return;
        try {
            await apiPost(`/api/v1/collections/${collection}/deleteOne`, { filter: { _id: docId } });
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
                <div className="input-group">
                    <label className="label">Collection</label>
                    <select className="select" value={collection} onChange={e => { setCollection(e.target.value); setSelectedDoc(null); }}>
                        {collections.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
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
    const [collection, setCollection] = useState(collections[0]?.name || '');
    const [indexes, setIndexes] = useState<IndexInfo[]>([]);
    const [newField, setNewField] = useState('');
    const [unique, setUnique] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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
                <div className="card-title" style={{ marginBottom: 16 }}>Create Index</div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <div className="input-group" style={{ flex: 1, marginBottom: 0 }}>
                        <label className="label">Collection</label>
                        <select className="select" value={collection} onChange={e => setCollection(e.target.value)}>
                            {collections.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
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
    if (!metrics) {
        return <div className="loading-center"><div className="spinner" /></div>;
    }

    const commandData = Object.entries(metrics.requests.byCommand).map(([name, count]) => ({ name, count }));

    return (
        <div className="fade-in">
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
        query: { title: 'Query Builder', subtitle: 'Build and execute MongoDB-compatible queries' },
        explorer: { title: 'Document Explorer', subtitle: 'Browse, edit, and delete documents' },
        indexes: { title: 'Index Manager', subtitle: 'Create and manage collection indexes' },
        metrics: { title: 'Metrics & Monitoring', subtitle: 'Server performance and health metrics' },
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
                    {activeTab === 'query' && <QueryBuilderTab collections={collections} />}
                    {activeTab === 'explorer' && <DocumentExplorerTab collections={collections} />}
                    {activeTab === 'indexes' && <IndexManagerTab collections={collections} onRefresh={loadCollections} />}
                    {activeTab === 'metrics' && <MetricsTab metrics={metrics} />}
                </div>
            </main>
        </div>
    );
}
