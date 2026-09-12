'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, type Variants } from 'framer-motion';
import { apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Icon } from '@/lib/icons';
import type { CollectionInfo, MetricsData, UserMetrics, ProtocolInfo } from '../types';
import { formatUptime } from '../types';

const container: Variants = {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren: 0.06, delayChildren: 0.03 } },
};

const item: Variants = {
    hidden: { opacity: 0, y: 10 },
    show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } },
};

/** Rolling client-side sample buffer for the QPS sparkline — built from real polled metrics, not fabricated. */
function useQpsHistory(metrics: MetricsData | null, maxPoints = 24) {
    const [history, setHistory] = useState<number[]>([]);
    const lastTotal = useRef<number | null>(null);
    const lastTs = useRef<number | null>(null);

    useEffect(() => {
        if (!metrics) return;
        const now = metrics.timestamp;
        if (lastTotal.current !== null && lastTs.current !== null) {
            const deltaRequests = metrics.requests.total - lastTotal.current;
            const deltaSeconds = Math.max(1, (now - lastTs.current) / 1000);
            const qps = Math.max(0, deltaRequests / deltaSeconds);
            setHistory(h => [...h, qps].slice(-maxPoints));
        }
        lastTotal.current = metrics.requests.total;
        lastTs.current = now;
    }, [metrics, maxPoints]);

    return history;
}

function Sparkline({ values }: { values: number[] }) {
    if (values.length < 2) {
        return <div style={{ height: 40, display: 'flex', alignItems: 'center', fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>collecting samples…</div>;
    }
    const max = Math.max(...values, 1);
    const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${40 - (v / max) * 36}`).join(' ');
    return (
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" style={{ width: '100%', height: 40 }}>
            <polyline points={points} fill="none" stroke="var(--accent-primary)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
    );
}

export function OverviewTab({ collections, metrics }: { collections: CollectionInfo[]; metrics: MetricsData | null }) {
    const { address, isAuthenticated } = useAuth();
    const [userMetrics, setUserMetrics] = useState<UserMetrics | null>(null);
    const [protocols, setProtocols] = useState<ProtocolInfo[]>([]);
    const totalDocs = collections.reduce((s, c) => s + c.documentCount, 0);
    const totalIndexes = collections.reduce((s, c) => s + c.indexCount, 0);
    const qpsHistory = useQpsHistory(metrics);
    const currentQps = qpsHistory.length ? qpsHistory[qpsHistory.length - 1] : 0;

    useEffect(() => {
        if (isAuthenticated && address) {
            apiGet<UserMetrics>(`/api/v1/user/${address}/metrics`).then(setUserMetrics).catch(() => {});
        }
    }, [isAuthenticated, address]);

    useEffect(() => {
        apiGet<{ protocols: ProtocolInfo[] }>('/api/v1/protocols').then(res => setProtocols(res.protocols || [])).catch(() => {});
    }, []);

    return (
        <motion.div variants={container} initial="hidden" animate="show">
            {/* Primary readout: QPS with a live sparkline, plus three quieter companions */}
            <motion.div variants={item} style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr', gap: 16, marginBottom: 28 }}>
                <div className="stat-card stat-card-hero" style={{ borderLeftColor: 'var(--accent-primary)' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                        <div className="stat-label">Throughput</div>
                        <div className="icon-badge icon-badge-primary"><Icon name="activity" size={15} /></div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
                        <div className="stat-value stat-value-hero">{currentQps.toFixed(1)}<span style={{ fontSize: 13, fontWeight: 500, marginLeft: 4, color: 'var(--text-tertiary)', WebkitTextFillColor: 'var(--text-tertiary)' }}>qps</span></div>
                    </div>
                    <div style={{ marginTop: 4 }}><Sparkline values={qpsHistory} /></div>
                </div>
                <div className="stat-card">
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                        <div className="stat-label">Collections</div>
                        <div className="icon-badge icon-badge-secondary"><Icon name="database" size={15} /></div>
                    </div>
                    <div className="stat-value">{collections.length}</div>
                    <div className="stat-change">active namespaces</div>
                </div>
                <div className="stat-card">
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                        <div className="stat-label">Documents</div>
                        <div className="icon-badge icon-badge-tertiary"><Icon name="layers" size={15} /></div>
                    </div>
                    <div className="stat-value">{totalDocs.toLocaleString()}</div>
                    <div className="stat-change">across all collections</div>
                </div>
                <div className="stat-card">
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                        <div className="stat-label">Indexes</div>
                        <div className="icon-badge icon-badge-warning"><Icon name="index" size={15} /></div>
                    </div>
                    <div className="stat-value">{totalIndexes}</div>
                    <div className="stat-change">including _id indexes</div>
                </div>
            </motion.div>

            {/* Protocol lines — jack/connector status, real data from /api/v1/protocols */}
            <motion.div variants={item} style={{ marginBottom: 28 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                    <div className="icon-badge icon-badge-primary"><Icon name="plug" size={15} /></div>
                    <div className="section-label">Protocol lines</div>
                </div>
                {protocols.length === 0 ? (
                    <div style={{ display: 'flex', gap: 10 }}>
                        {[88, 76, 92, 70].map((w, i) => <div key={i} className="skeleton-pill" style={{ width: w, animationDelay: `${i * 0.12}s` }} />)}
                    </div>
                ) : (
                    <div className="jack-row">
                        {protocols.map(p => (
                            <div key={p.name} className={`jack ${p.enabled ? 'live' : ''}`}>
                                <span className="jack-socket"><span className="jack-pin" /></span>
                                <span style={{ textTransform: 'capitalize', color: 'inherit' }}>{p.name}</span>
                                <span style={{ opacity: 0.6 }}>:{p.port}</span>
                                {p.enabled && p.connections > 0 && <span style={{ opacity: 0.75 }}>· {p.connections}</span>}
                            </div>
                        ))}
                    </div>
                )}
            </motion.div>

            {/* User-scoped stats (when wallet connected) */}
            {isAuthenticated && userMetrics && (
                <motion.div variants={item} style={{ marginBottom: 28 }}>
                    <div className="section-label user" style={{ marginBottom: 12 }}>Your account</div>
                    <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                        <div className="stat-card">
                            <div className="stat-label">Collections</div>
                            <div className="stat-value">{userMetrics.collections}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Documents</div>
                            <div className="stat-value">{userMetrics.documents.toLocaleString()}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">API keys</div>
                            <div className="stat-value">{userMetrics.apiKeys}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Requests</div>
                            <div className="stat-value">{userMetrics.totalRequests.toLocaleString()}</div>
                        </div>
                    </div>
                </motion.div>
            )}

            <motion.div variants={item} className="grid-2">
                <div className="card">
                    <div className="card-header">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div className="icon-badge icon-badge-secondary"><Icon name="database" size={15} /></div>
                            <div className="card-title">Recent collections</div>
                        </div>
                    </div>
                    {collections.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-state-title">No collections yet</div>
                            <div className="empty-state-text">Insert a document through any protocol to create one automatically.</div>
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
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div className="icon-badge icon-badge-primary"><Icon name="chart" size={15} /></div>
                            <div className="card-title">Performance</div>
                        </div>
                    </div>
                    {metrics ? (
                        <div style={{ display: 'grid', gap: '12px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-primary)' }}>
                                <span style={{ color: 'var(--text-secondary)' }}>Avg latency</span>
                                <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{metrics.latency.avg.toFixed(1)}ms</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-primary)' }}>
                                <span style={{ color: 'var(--text-secondary)' }}>P95 latency</span>
                                <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{metrics.latency.p95.toFixed(1)}ms</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-primary)' }}>
                                <span style={{ color: 'var(--text-secondary)' }}>P99 latency</span>
                                <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{metrics.latency.p99.toFixed(1)}ms</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-primary)' }}>
                                <span style={{ color: 'var(--text-secondary)' }}>Total requests</span>
                                <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{metrics.requests.total.toLocaleString()}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-primary)' }}>
                                <span style={{ color: 'var(--text-secondary)' }}>Errors</span>
                                <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', color: metrics.errors.total > 0 ? 'var(--accent-error)' : 'var(--accent-success)' }}>{metrics.errors.total}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
                                <span style={{ color: 'var(--text-secondary)' }}>Uptime</span>
                                <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{formatUptime(metrics.uptime)}</span>
                            </div>
                        </div>
                    ) : (
                        <div className="loading-center"><div className="spinner" /></div>
                    )}
                </div>
            </motion.div>

            {/* Architecture facts — flat, no gradient-wash decoration; the left rule marks
                each as a distinct technical claim rather than a colored SaaS card. */}
            <motion.div variants={item} className="card" style={{ marginTop: 28 }}>
                <div className="card-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div className="icon-badge icon-badge-tertiary"><Icon name="zap" size={15} /></div>
                        <div className="card-title">How storage works</div>
                    </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 28, marginTop: 6 }}>
                    <div style={{ paddingLeft: 16, borderLeft: '2px solid var(--accent-primary)' }}>
                        <div style={{ fontSize: 14.5, fontWeight: 700, letterSpacing: '-0.2px', marginBottom: 8, color: 'var(--text-primary)' }}>Merkle Patricia Trie</div>
                        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.65 }}>Every write produces a cryptographic proof, with O(log n) lookups via MonadDb&apos;s trie structure.</div>
                    </div>
                    <div style={{ paddingLeft: 16, borderLeft: '2px solid var(--accent-secondary)' }}>
                        <div style={{ fontSize: 14.5, fontWeight: 700, letterSpacing: '-0.2px', marginBottom: 8, color: 'var(--text-primary)' }}>Parallel execution</div>
                        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.65 }}>Monad&apos;s 10,000 TPS layer runs concurrent index maintenance without lock contention.</div>
                    </div>
                    <div style={{ paddingLeft: 16, borderLeft: '2px solid var(--accent-tertiary)' }}>
                        <div style={{ fontSize: 14.5, fontWeight: 700, letterSpacing: '-0.2px', marginBottom: 8, color: 'var(--text-primary)' }}>Wire compatible</div>
                        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.65 }}>Connect with mongosh, psql, redis-cli, or native drivers — no new client to learn.</div>
                    </div>
                </div>
            </motion.div>
        </motion.div>
    );
}
