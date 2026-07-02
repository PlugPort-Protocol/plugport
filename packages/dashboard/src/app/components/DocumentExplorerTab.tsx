'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Icon } from '@/lib/icons';
import type { CollectionInfo, ScopeState } from '../types';
import { ScopeToggle } from './ScopeToggle';

export function DocumentExplorerTab({ collections }: { collections: CollectionInfo[] }) {
    const { address, isAuthenticated } = useAuth();
    const [scope, setScope] = useState<ScopeState>(isAuthenticated ? 'my' : 'all');
    const [collection, setCollection] = useState(collections[0]?.name || '');
    const [documents, setDocuments] = useState<Record<string, unknown>[]>([]);
    const [selectedDoc, setSelectedDoc] = useState<Record<string, unknown> | null>(null);
    const [editMode, setEditMode] = useState(false);
    const [editJson, setEditJson] = useState('');
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    const visibleCollections = scope === 'my' && isAuthenticated
        ? collections.filter(c => c.ownerAddress === address)
        : collections;

    // Reset collection selection when scope changes
    useEffect(() => {
        if (visibleCollections.length > 0 && !visibleCollections.find(c => c.name === collection)) {
            setCollection(visibleCollections[0].name);
        }
    }, [scope, visibleCollections, collection]);

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
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        }
    };

    const handleDelete = async (id: string) => {
        if (!collection) return;
        try {
            await apiPost(`/api/v1/collections/${collection}/deleteOne`, { filter: { _id: id } });
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div className="input-group" style={{ flex: 1, marginBottom: 0, marginRight: 16 }}>
                        <label className="label">Collection</label>
                        <select className="select" value={collection} onChange={e => { setCollection(e.target.value); setSelectedDoc(null); }}>
                            {visibleCollections.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                        </select>
                    </div>
                    {isAuthenticated && <ScopeToggle scope={scope} setScope={setScope} />}
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
