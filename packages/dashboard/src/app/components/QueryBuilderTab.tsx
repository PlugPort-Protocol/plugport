'use client';

import { useState, useEffect, useRef } from 'react';
import { apiPost } from '@/lib/api';
import { Icon } from '@/lib/icons';
import type { CollectionInfo } from '../types';

export function QueryBuilderTab({ collections }: { collections: CollectionInfo[] }) {
    const [dialect, setDialect] = useState<'mongo' | 'sql' | 'redis'>('mongo');
    const [mongoMode, setMongoMode] = useState<'find' | 'aggregate'>('find');
    const [collection, setCollection] = useState(collections[0]?.name || '');
    const [filter, setFilter] = useState('{}');
    const [projection, setProjection] = useState('');
    const [sort, setSort] = useState('');
    const [limit, setLimit] = useState('50');
    const [pipeline, setPipeline] = useState('[]');
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
            if (dialect === 'mongo' && mongoMode === 'aggregate') {
                const parsedPipeline = JSON.parse(pipeline || '[]');
                if (!Array.isArray(parsedPipeline)) throw new Error('Pipeline must be a JSON array');

                const result = await apiPost<{ cursor: { firstBatch: Record<string, unknown>[] }; ok: number; errmsg?: string }>(
                    `/api/v1/collections/${collection}/aggregate`, { pipeline: parsedPipeline }
                );
                if (result.ok !== 1) throw new Error(result.errmsg || 'Aggregation failed');
                setResults(result.cursor.firstBatch);
            } else if (dialect === 'mongo') {
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
                <div className="card-header" style={{ alignItems: 'center' }}>
                    <div className="tabs" style={{ marginBottom: 0 }}>
                        {(['mongo', 'sql', 'redis'] as const).map(d => (
                            <button
                                key={d}
                                className={`tab ${dialect === d ? 'active' : ''}`}
                                style={{ textTransform: 'uppercase' }}
                                onClick={() => { setDialect(d); setResults(null); setError(null); stopSse(); }}
                            >
                                {d}
                            </button>
                        ))}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                        {results && <span className="badge badge-success">{results.length} results in {execTime}ms</span>}
                        {sseActive && <span className="badge badge-warning blink">Live Stream Active</span>}
                    </div>
                </div>

                {dialect === 'mongo' && (
                    <>
                        {/* Find / Aggregate toggle */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
                            <div className="tabs" style={{ marginBottom: 0 }}>
                                {(['find', 'aggregate'] as const).map(m => (
                                    <button
                                        key={m}
                                        className={`tab ${mongoMode === m ? 'active' : ''}`}
                                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textTransform: 'capitalize' }}
                                        onClick={() => { setMongoMode(m); setResults(null); setError(null); }}
                                    >
                                        <Icon name={m === 'aggregate' ? 'zap' : 'search'} size={13} /> {m}
                                    </button>
                                ))}
                            </div>
                            <div className="input-group" style={{ flex: 1, marginBottom: 0 }}>
                                <select className="select" value={collection} onChange={e => setCollection(e.target.value)} style={{ marginBottom: 0 }}>
                                    {collections.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                                    <option value="">-- enter manually --</option>
                                </select>
                            </div>
                        </div>

                        {mongoMode === 'find' ? (
                            <>
                                <div className="grid-2" style={{ marginBottom: 16 }}>
                                    <div className="input-group">
                                        <label className="label">Filter (JSON)</label>
                                        <textarea className="textarea" value={filter} onChange={e => setFilter(e.target.value)} rows={3} placeholder='{"field": "value"}' />
                                    </div>
                                    <div className="input-group">
                                        <label className="label">Limit</label>
                                        <input className="input" type="number" value={limit} onChange={e => setLimit(e.target.value)} />
                                    </div>
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
                        ) : (
                            <>
                                <div className="input-group">
                                    <label className="label">Pipeline (JSON array of stages)</label>
                                    <textarea
                                        className="textarea input-mono"
                                        value={pipeline}
                                        onChange={e => setPipeline(e.target.value)}
                                        rows={8}
                                        placeholder={`[\n  { "$match": { "status": "active" } },\n  { "$lookup": { "from": "users", "localField": "userId", "foreignField": "_id", "as": "user" } },\n  { "$sort": { "createdAt": -1 } },\n  { "$limit": 10 }\n]`}
                                    />
                                </div>
                                <div style={{ display: 'flex', gap: 8, marginTop: 4, marginBottom: 12, flexWrap: 'wrap' }}>
                                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: '26px' }}>Templates:</span>
                                    {[
                                        { label: '$match + $sort', value: '[{"$match": {"status": "active"}}, {"$sort": {"createdAt": -1}}, {"$limit": 20}]' },
                                        { label: '$lookup', value: `[{"$match": {}}, {"$lookup": {"from": "${collections[1]?.name || 'related'}", "localField": "_id", "foreignField": "refId", "as": "joined"}}, {"$limit": 10}]` },
                                        { label: '$unwind + $count', value: '[{"$unwind": "$items"}, {"$count": "totalItems"}]' },
                                        { label: '$project', value: '[{"$project": {"name": 1, "email": 1, "_id": 0}}]' },
                                    ].map(t => (
                                        <button
                                            key={t.label}
                                            className="btn btn-sm btn-secondary"
                                            style={{ fontSize: 11, padding: '3px 10px' }}
                                            onClick={() => setPipeline(t.value)}
                                        >
                                            {t.label}
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
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
            ) : (
                <div className="card">
                    <div className="empty-state">
                        <div className="icon-badge icon-badge-primary" style={{ width: 44, height: 44, borderRadius: 13, margin: '0 auto 16px' }}>
                            <Icon name="play" size={20} />
                        </div>
                        <div className="empty-state-title">Results will show up here</div>
                        <div className="empty-state-text">Build a query above and hit Execute to see documents, rows, or streamed events.</div>
                    </div>
                </div>
            )}
        </div>
    );
}
