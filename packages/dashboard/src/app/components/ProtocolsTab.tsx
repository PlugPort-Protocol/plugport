'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Icon } from '@/lib/icons';
import type { ProtocolInfo } from '../types';

export function ProtocolsTab() {
    const { address } = useAuth();
    const [protocols, setProtocols] = useState<ProtocolInfo[]>([]);
    const [isDeployer, setIsDeployer] = useState(false);
    const [deployerAddress, setDeployerAddress] = useState<string | null>(null);
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

    // Unlike every other protocol, Redis has no per-caller isolation yet —
    // every authenticated client (wire or HTTP passthrough) shares one
    // global keyspace. Surfaced here so anyone about to connect a real
    // client sees it before storing anything sensitive.
    const caveatMap: Record<string, string> = {
        redis: 'Shared keyspace: unlike the other protocols, Redis has no per-caller isolation — every authenticated client reads and writes the same keys. Do not store sensitive or tenant-specific data here.',
    };

    const loadProtocols = useCallback(async () => {
        try {
            const res = await apiGet<{ protocols: ProtocolInfo[]; isDeployer?: boolean; deployerAddress?: string | null }>('/api/v1/protocols');
            setProtocols(res.protocols || []);
            setIsDeployer(!!res.isDeployer);
            setDeployerAddress(res.deployerAddress ?? null);
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
                                {p.enabled && caveatMap[p.name] && (
                                    <div style={{
                                        display: 'flex',
                                        alignItems: 'flex-start',
                                        gap: 6,
                                        marginTop: 8,
                                        fontSize: 12,
                                        color: 'var(--accent-warning)',
                                        maxWidth: 480,
                                    }}>
                                        <span style={{ flexShrink: 0, marginTop: 1 }}><Icon name="alert-triangle" size={13} /></span>
                                        <span>{caveatMap[p.name]}</span>
                                    </div>
                                )}
                            </div>
                            <div>
                                {p.name !== 'http' && (
                                    isDeployer ? (
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
                                    ) : (
                                        <span
                                            className="status-text"
                                            title={deployerAddress ? `Only the deployer (${deployerAddress}) can manage protocols` : 'Only the deployer can manage protocols'}
                                            style={{ fontSize: 11 }}
                                        >
                                            <Icon name="lock" size={12} /> Deployer only
                                        </span>
                                    )
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
                    Each runs on its own port and can be enabled or disabled at runtime by the deployer.
                </div>
            </div>
        </div>
    );
}
