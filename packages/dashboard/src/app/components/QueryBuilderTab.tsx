'use client';

import { useState, useEffect, useRef } from 'react';
import { apiPost } from '@/lib/api';
import { Icon } from '@/lib/icons';
import type { CollectionInfo } from '../types';

export function QueryBuilderTab({ collections }: { collections: CollectionInfo[] }) {
    const [dialect, setDialect] = useState<'mongo' | 'sql' | 'redis'>('mongo');
    const [collection, setCollection] = useState(collections[0]?.name || '');
    const [filter, setFilter] = useState('{}');
    const [projection, setProjection] = useState('');
    const [sort, setSort] = useState('');
    const [limit, setLimit] = useState('50');
    const [sqlQuery, setSqlQuery] = useState('');
    const [redisCmd, setRedisCmd] = useState('');
    const [results, setResults] = useState<Record<string, unknown>[] | null>(null);
    const [sseMessages, setSseMessages] = useState<string[]>([]);
    const [sseActive, setSseActive] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [execTime, setExecTime] = useState(0);
    const sseRef = useRef<EventSource | null>(null);

    useEffect(() => {
        return () => stopSse();
    }, []);

    const stopSse = () => {
        if (sseRef.current) {
            sseRef.current.close();
            sseRef.current = null;
        }
        setSseActive(false);
    };

    const executeQuery = async () => {
        stopSse();
        setLoading(true);
        setError(null);
        setResults(null);
        setSseMessages([]);
        const start = Date.now();
        try {
            if (dialect === 'mongo') {
                const body: Record<string, unknown> = { filter: JSON.parse(filter || '{}') };
                if (projection) body.projection = JSON.parse(projection);
                if (sort) body.sort = JSON.parse(sort);
                if (limit) body.limit = parseInt(limit);

                const result = await apiPost<{ cursor: { firstBatch: Record<string, unknown>[] } }>(
                    `/api/v1/collections/${collection}/find`, body
                );
                setResults(result.cursor.firstBatch);
            } else if (dialect === 'sql') {
                const result = await apiPost<{ result: Record<string, unknown>[] }>(`/api/v1/sql`, { query: sqlQuery });
                setResults(result.result || []);
            } else if (dialect === 'redis') {
                if (redisCmd.toUpperCase().startsWith('SUBSCRIBE')) {
                    const channel = redisCmd.split(' ')[1];
                    if (!channel) throw new Error('Specify a channel (e.g. SUBSCRIBE ch1)');
                    const token = localStorage.getItem('auth_token') || '';
                    const url = new URL(window.location.origin);
                    url.pathname = '/api/v1/redis/stream';
                    url.searchParams.set('channels', channel);
                    if (token) url.searchParams.set('token', token);
                    
                    const es = new EventSource(url.toString());
                    sseRef.current = es;
                    setSseActive(true);
                    es.onmessage = (e) => {
                        setSseMessages(prev => [...prev, e.data]);
                    };
                    es.onerror = () => {
                        es.close();
                        setSseActive(false);
                    };
                    setLoading(false);
                    return;
                }
                const result = await apiPost<{ result: unknown }>(`/api/v1/redis`, { command: redisCmd });
                setResults([{ value: result.result }]);
            }
            setExecTime(Date.now() - start);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Query failed');
        } finally {
            if (dialect !== 'redis' || !redisCmd.toUpperCase().startsWith('SUBSCRIBE')) {
                setLoading(false);
            }
        }
    };

    const exportJSON = () => {
        if (!results) return;
        const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${dialect}_export.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div className="fade-in">
            <div className="card" style={{ marginBottom: 24 }}>
                <div className="card-header">
                    <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        Query Builder
                        <div style={{ display: 'flex', background: 'var(--bg-tertiary)', borderRadius: 6, padding: 2 }}>
                            {['mongo', 'sql', 'redis'].map(d => (
                                <button
                                    key={d}
                                    style={{
                                        border: 'none', background: dialect === d ? 'var(--bg-primary)' : 'transparent',
                                        color: dialect === d ? 'var(--text-primary)' : 'var(--text-tertiary)',
                                        padding: '4px 12px', fontSize: 12, fontWeight: 600, borderRadius: 4, cursor: 'pointer',
                                        textTransform: 'uppercase'
                                    }}
                                    onClick={() => { setDialect(d as 'mongo' | 'sql' | 'redis'); setResults(null); setError(null); stopSse(); }}
                                >
                                    {d}
                                </button>
                            ))}
                        </div>
                    </div>
                    {results && <span className="badge badge-success">{results.length} results in {execTime}ms</span>}
                    {sseActive && <span className="badge badge-warning blink">Live Stream Active</span>}
                </div>

                {dialect === 'mongo' && (
                    <>
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
                    </>
                )}

                {dialect === 'sql' && (
                    <div className="input-group">
                        <label className="label">SQL Query</label>
                        <textarea className="textarea input-mono" value={sqlQuery} onChange={e => setSqlQuery(e.target.value)} rows={4} placeholder="SELECT * FROM users WHERE age > 18" />
                    </div>
                )}

                {dialect === 'redis' && (
                    <div className="input-group">
                        <label className="label">Redis Command</label>
                        <input className="input input-mono" value={redisCmd} onChange={e => setRedisCmd(e.target.value)} placeholder="GET mykey or SUBSCRIBE channel1" />
                    </div>
                )}

                <div style={{ display: 'flex', gap: 12 }}>
                    {!sseActive ? (
                        <button className="btn btn-primary" onClick={executeQuery} disabled={loading || (dialect === 'mongo' && !collection)}>
                            {loading ? <div className="spinner" style={{ width: 16, height: 16 }} /> : <Icon name="play" size={16} />}
                            Execute
                        </button>
                    ) : (
                        <button className="btn btn-danger" onClick={stopSse}>
                            Stop Stream
                        </button>
                    )}
                    {results && !sseActive && (
                        <button className="btn btn-secondary" onClick={exportJSON}>
                            <Icon name="download" size={16} /> Export JSON
                        </button>
                    )}
                </div>

                {error && <div className="alert alert-error" style={{ marginTop: 16 }}>{error}</div>}
            </div>

            {sseActive || sseMessages.length > 0 ? (
                <div className="card">
                    <div className="card-header">
                        <div className="card-title">Pub/Sub Stream ({sseMessages.length} events)</div>
                    </div>
                    <div className="terminal-window" style={{ background: '#1e1e1e', color: '#00ff00', padding: 16, borderRadius: 8, height: 300, overflow: 'auto', fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>
                        {sseMessages.map((msg, i) => (
                            <div key={i}>{msg}</div>
                        ))}
                        {sseActive && <div className="blink" style={{ marginTop: 8 }}>_</div>}
                    </div>
                </div>
            ) : results ? (
                <div className="card">
                    <div className="card-header">
                        <div className="card-title">Results ({results.length} documents)</div>
                    </div>
                    {results.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-state-title">No results found</div>
                            <div className="empty-state-text">Try adjusting your query</div>
                        </div>
                    ) : (
                        <div className="table-container" style={{ maxHeight: 500, overflow: 'auto' }}>
                            <table className="table">
                                <thead>
                                    <tr>
                                        {Object.keys(results[0] || {}).map(key => <th key={key}>{key}</th>)}
                                    </tr>
                                </thead>
                                <tbody>
                                    {results.map((doc, i) => (
                                        <tr key={i}>
                                            {Object.values(doc || {}).map((val, j) => (
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
            ) : null}
        </div>
    );
}
