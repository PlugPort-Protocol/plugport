'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import type { ProtocolInfo } from '../types';

export function ProtocolsTab() {
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
