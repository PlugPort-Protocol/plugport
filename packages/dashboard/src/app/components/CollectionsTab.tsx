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
    const [insertVisibility, setInsertVisibility] = useState<'public' | 'private'>('public');
    const [insertResult, setInsertResult] = useState<string | null>(null);
    const [inserting, setInserting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Only offer a visibility choice when this insert would create a brand-new
    // collection — an existing collection already has its privacy mode set,
    // and inserting into it shouldn't silently change that.
    const isNewCollection = isAuthenticated
        && insertCollection.trim() !== ''
        && !collections.some(c => c.name === insertCollection.trim());

    const handleInsert = async () => {
        const targetCollection = insertCollection;
        const claimingOwnership = isNewCollection;
        setInserting(true);
        setInsertResult(null);
        try {
            const doc = JSON.parse(insertDoc);
            const result = await apiPost(`/api/v1/collections/${targetCollection}/insertOne`, { document: doc });
            let resultText = JSON.stringify(result, null, 2);

            if (claimingOwnership) {
                try {
                    await apiPost(`/api/v1/collections/${targetCollection}/privacy`, { mode: insertVisibility });
                    resultText += `\n\n✓ "${targetCollection}" created as ${insertVisibility} — you're now its owner.`;
                } catch (privacyErr) {
                    resultText += `\n\n⚠ Document inserted, but setting visibility failed: ${privacyErr instanceof Error ? privacyErr.message : 'Unknown error'}. The collection is currently unowned — set it from the Privacy tab.`;
                }
            }

            setInsertResult(resultText);
            onRefresh();
        } catch (err) {
            setInsertResult(`Error: ${err instanceof Error ? err.message : 'Unknown'}`);
        } finally {
            setInserting(false);
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
                            <input className="input" value={insertCollection} onChange={e => setInsertCollection(e.target.value)} placeholder="users" disabled={inserting} />
                        </div>
                        {isNewCollection && (
                            <div className="input-group">
                                <label className="label">Visibility for new collection</label>
                                <div className="tabs" style={{ marginBottom: 0 }}>
                                    <button type="button" className={`tab ${insertVisibility === 'public' ? 'active' : ''}`} onClick={() => setInsertVisibility('public')} disabled={inserting}>
                                        Public
                                    </button>
                                    <button type="button" className={`tab ${insertVisibility === 'private' ? 'active' : ''}`} onClick={() => setInsertVisibility('private')} disabled={inserting}>
                                        Private
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                    {isNewCollection && (
                        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: -8, marginBottom: 16 }}>
                            {insertVisibility === 'public'
                                ? `"${insertCollection}" doesn't exist yet — it'll be created as public (world-readable) and you'll be recorded as its owner, so it shows under "My Data".`
                                : `"${insertCollection}" doesn't exist yet — it'll be created as private (AES-256-GCM encrypted, only you + addresses you whitelist can access) with you as owner.`}
                        </div>
                    )}
                    <div className="input-group">
                        <label className="label">Document (JSON)</label>
                        <textarea className="textarea" value={insertDoc} onChange={e => setInsertDoc(e.target.value)} rows={6} disabled={inserting} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <button className="btn btn-primary" onClick={handleInsert} disabled={!insertCollection || inserting} style={{ minWidth: 110 }}>
                            {inserting
                                ? <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Inserting…</>
                                : <><Icon name="play" size={16} /> Insert</>}
                        </button>
                        {inserting && (
                            <span className="status-text" style={{ fontSize: 12 }}>
                                Writing to the blockchain — this takes 10-15s while the transaction confirms.
                            </span>
                        )}
                    </div>
                    {insertResult && (
                        <pre className="json-view" style={{ marginTop: 16 }}>{insertResult}</pre>
                    )}
                </div>
            )}

            {visibleCollections.length === 0 ? (
                <div className="card" style={{ padding: '64px 32px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ position: 'relative', marginBottom: 32 }}>
                        <div style={{
                            width: 80,
                            height: 80,
                            background: 'linear-gradient(160deg, var(--bg-card-hover), var(--bg-tertiary) 65%)',
                            borderRadius: '24px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            position: 'relative',
                            color: 'var(--accent-primary)',
                            boxShadow: 'var(--shadow-md), var(--inset-highlight)',
                        }}>
                            <Icon name="database" size={40} />
                            <div style={{
                                position: 'absolute',
                                bottom: -10,
                                right: -14,
                                background: 'var(--accent-primary)',
                                color: '#fffdfd',
                                width: 34,
                                height: 34,
                                borderRadius: '11px',
                                boxShadow: '0 2px 6px rgba(110, 84, 255, 0.35), 0 8px 18px rgba(110, 84, 255, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.3)',
                                transform: 'rotate(-6deg)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center'
                            }}>
                                <Icon name="plus" size={18} />
                            </div>
                        </div>
                    </div>

                    <h3 style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.4px', color: 'var(--text-primary)', marginBottom: '12px' }}>No Collections Yet</h3>
                    <p style={{ color: 'var(--text-secondary)', maxWidth: '420px', margin: '0 auto 32px', lineHeight: 1.6 }}>
                        Collections are automatically created when you insert your first document. Ready to start building your database?
                    </p>

                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                        <button className="btn btn-secondary" style={{ borderRadius: '100px', padding: '12px 32px' }} onClick={() => setShowInsert(true)}>
                            <span>Try inserting one now</span>
                            <Icon name="arrow-right" size={16} />
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
