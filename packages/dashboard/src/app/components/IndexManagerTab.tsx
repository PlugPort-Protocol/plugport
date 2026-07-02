'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Icon } from '@/lib/icons';
import type { CollectionInfo, IndexInfo, ScopeState } from '../types';
import { ScopeToggle } from './ScopeToggle';

export function IndexManagerTab({ collections, onRefresh }: { collections: CollectionInfo[]; onRefresh: () => void }) {
    const { address, isAuthenticated } = useAuth();
    const [scope, setScope] = useState<ScopeState>(isAuthenticated ? 'my' : 'all');
    const [collection, setCollection] = useState(collections[0]?.name || '');
    const [indexes, setIndexes] = useState<IndexInfo[]>([]);
    const [newField, setNewField] = useState('');
    const [unique, setUnique] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    const visibleCollections = scope === 'my' && isAuthenticated
        ? collections.filter(c => c.ownerAddress === address)
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
        } catch {
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
