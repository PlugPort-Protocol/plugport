'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, apiDelete } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Icon } from '@/lib/icons';
import type { ApiKeyInfo, KeyAnalytics } from '../types';

export function ApiKeysTab() {
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
