'use client';

import { useState, useEffect } from 'react';
import { apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { MetricsData, UserMetrics, ScopeState } from '../types';
import { formatUptime, formatBytes } from '../types';
import { ScopeToggle } from './ScopeToggle';

export function MetricsTab({ metrics }: { metrics: MetricsData | null }) {
    const { address, isAuthenticated } = useAuth();
    const [scope, setScope] = useState<ScopeState>(isAuthenticated ? 'both' : 'all');
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
            {isAuthenticated && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 24 }}>
                    <ScopeToggle scope={scope} setScope={setScope} allowBoth={true} />
                </div>
            )}

            {/* User-scoped metrics */}
            {isAuthenticated && userMetrics && (scope === 'my' || scope === 'both') && (
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

            {(scope === 'all' || scope === 'both') && (
                <>
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
            </>
            )}
        </div>
    );
}
