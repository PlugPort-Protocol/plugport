'use client';

import { useState, useEffect } from 'react';
import { apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { CollectionInfo, MetricsData, UserMetrics } from '../types';
import { formatUptime } from '../types';

export function OverviewTab({ collections, metrics }: { collections: CollectionInfo[]; metrics: MetricsData | null }) {
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
                        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>Every document write produces a cryptographic proof. Verifiable storage with O(log n) lookups via MonadDb&apos;s optimized trie structure.</div>
                    </div>
                    <div style={{ padding: '16px', background: 'rgba(0,212,170,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(0,212,170,0.1)' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: 'var(--accent-secondary)' }}>Parallel Execution</div>
                        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>Monad&apos;s 10,000 TPS execution layer enables high-throughput document operations. Concurrent index maintenance without lock contention.</div>
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
