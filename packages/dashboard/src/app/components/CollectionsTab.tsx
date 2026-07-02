'use client';

import { useState, useRef } from 'react';
import { apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Icon } from '@/lib/icons';
import type { CollectionInfo, ScopeState } from '../types';
import { ScopeToggle } from './ScopeToggle';

export function CollectionsTab({ collections, onRefresh }: { collections: CollectionInfo[]; onRefresh: () => void }) {
    const { address, isAuthenticated } = useAuth();
    const [scope, setScope] = useState<ScopeState>(isAuthenticated ? 'my' : 'all');
    const [showInsert, setShowInsert] = useState(false);
    const [insertCollection, setInsertCollection] = useState('');
    const [insertDoc, setInsertDoc] = useState('{\n  "name": "Alice",\n  "email": "alice@example.com"\n}');
    const [insertResult, setInsertResult] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleInsert = async () => {
        try {
            const doc = JSON.parse(insertDoc);
            const result = await apiPost(`/api/v1/collections/${insertCollection}/insertOne`, { document: doc });
            setInsertResult(JSON.stringify(result, null, 2));
            onRefresh();
        } catch (err) {
            setInsertResult(`Error: ${err instanceof Error ? err.message : 'Unknown'}`);
        }
    };

    const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const colName = prompt('Enter collection name to import into:', 'users');
        if (!colName) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
            try {
                const arr = JSON.parse(ev.target?.result as string);
                if (!Array.isArray(arr)) throw new Error('File must be a JSON array');
                const result = await apiPost(`/api/v1/collections/${colName}/insertMany`, { documents: arr });
                setInsertResult(JSON.stringify(result, null, 2));
                setShowInsert(true);
                onRefresh();
            } catch (err) {
                alert('Import failed: ' + (err instanceof Error ? err.message : 'Unknown'));
            }
        };
        reader.readAsText(file);
    };

    const visibleCollections = scope === 'my' && isAuthenticated
        ? collections.filter(c => c.ownerAddress === address)
        : collections;

    return (
        <div className="fade-in">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
                <div style={{ display: 'flex', gap: 12 }}>
                    <button className="btn btn-primary" onClick={() => setShowInsert(!showInsert)}>
                        <Icon name="plus" size={16} /> Insert Document
                    </button>
                    <button className="btn btn-secondary" onClick={onRefresh}>
                        <Icon name="refresh" size={16} /> Refresh
                    </button>
                    <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()}>
                        <Icon name="download" size={16} /> Import JSON
                    </button>
                    <input type="file" accept=".json" ref={fileInputRef} style={{ display: 'none' }} onChange={handleImport} />
                </div>
                {isAuthenticated && <ScopeToggle scope={scope} setScope={setScope} />}
            </div>

            {showInsert && (
                <div className="card" style={{ marginBottom: 24 }}>
                    <div className="card-title" style={{ marginBottom: 16 }}>Insert Document</div>
                    <div className="grid-2">
                        <div className="input-group">
                            <label className="label">Collection Name</label>
                            <input className="input" value={insertCollection} onChange={e => setInsertCollection(e.target.value)} placeholder="users" />
                        </div>
                        <div />
                    </div>
                    <div className="input-group">
                        <label className="label">Document (JSON)</label>
                        <textarea className="textarea" value={insertDoc} onChange={e => setInsertDoc(e.target.value)} rows={6} />
                    </div>
                    <button className="btn btn-primary" onClick={handleInsert} disabled={!insertCollection}>
                        <Icon name="play" size={16} /> Insert
                    </button>
                    {insertResult && (
                        <pre className="json-view" style={{ marginTop: 16 }}>{insertResult}</pre>
                    )}
                </div>
            )}

            {visibleCollections.length === 0 ? (
                <div className="card" style={{ padding: '64px 32px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div className="relative group mb-8" style={{ position: 'relative' }}>
                        <div style={{ 
                            width: 80, 
                            height: 80, 
                            background: 'var(--bg-tertiary)', 
                            borderRadius: '24px', 
                            display: 'flex', 
                            alignItems: 'center', 
                            justifyContent: 'center',
                            position: 'relative'
                        }}>
                            <Icon name="database" size={48} />
                            <div style={{ 
                                position: 'absolute',
                                bottom: -8,
                                right: -16,
                                background: 'var(--bg-secondary)',
                                color: 'var(--text-primary)',
                                padding: '8px',
                                borderRadius: '12px',
                                boxShadow: 'var(--shadow-md)',
                                transform: 'rotate(-6deg)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center'
                            }}>
                                <span className="material-icons-outlined" style={{ fontSize: 20, fontWeight: 'bold' }}>add</span>
                            </div>
                        </div>
                    </div>

                    <h3 style={{ fontSize: '24px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '12px' }}>No Collections Yet</h3>
                    <p style={{ color: 'var(--text-secondary)', maxWidth: '420px', margin: '0 auto 32px', lineHeight: 1.6 }}>
                        Collections are automatically created when you insert your first document. Ready to start building your database?
                    </p>

                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                        <button className="btn btn-secondary" style={{ borderRadius: '100px', padding: '12px 32px' }} onClick={() => setShowInsert(true)}>
                            <span>Try inserting one now</span>
                            <span className="material-icons-outlined" style={{ fontSize: 16 }}>arrow_forward</span>
                        </button>
                        <a href="#" style={{ fontSize: '14px', color: 'var(--text-tertiary)', textDecoration: 'underline', textUnderlineOffset: '4px' }}>
                            Read documentation about Collections
                        </a>
                    </div>
                </div>
            ) : (
                <div className="collection-grid">
                    {visibleCollections.map(c => (
                        <div className="collection-card" key={c.name}>
                            <div className="collection-name">{c.name}</div>
                            <div className="collection-meta">
                                <span>{c.documentCount.toLocaleString()} docs</span>
                                <span>{c.indexCount} indexes</span>
                                <span>Created {new Date(c.createdAt).toLocaleDateString()}</span>
                                {c.mode && <span style={{ color: c.mode === 'private' ? 'var(--accent-tertiary)' : 'var(--accent-secondary)' }}>{c.mode}</span>}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
