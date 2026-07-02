'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { Icon } from '@/lib/icons';
import type { CollectionInfo } from '../types';

export function PrivacyTab({ collections }: { collections: CollectionInfo[] }) {
    const [selectedCollection, setSelectedCollection] = useState(collections[0]?.name || '');
    const [storageMode, setStorageMode] = useState<string>('public');
    const [roles, setRoles] = useState<Record<string, number>>({});
    const [newAddress, setNewAddress] = useState('');
    const [newRole, setNewRole] = useState<number>(1);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [switching, setSwitching] = useState(false);

    const loadData = useCallback(async () => {
        if (!selectedCollection) return;
        try {
            const privacy = await apiGet<{ privacy: { mode: string; accessRoles: Record<string, number> } | null }>(`/api/v1/collections/${selectedCollection}/privacy`);
            setStorageMode(privacy.privacy?.mode || 'public');
            setRoles(privacy.privacy?.accessRoles || {});
        } catch {
            // Fallback: use global crypto configuration if available
            try {
                const health = await apiGet<{ cryptoEnabled?: boolean }>('/health');
                if (!health.cryptoEnabled) {
                    setStorageMode('public');
                }
            } catch { /* ignore */ }
        }
    }, [selectedCollection]);

    useEffect(() => { loadData(); }, [loadData]);

    const handleModeSwitch = async (mode: string) => {
        if (!selectedCollection || mode === storageMode) return;
        setSwitching(true);
        try {
            await apiPost(`/api/v1/collections/${selectedCollection}/privacy`, { mode });
            setMessage({ type: 'success', text: `${selectedCollection} switched to ${mode}` });
            setStorageMode(mode);
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to switch' });
        } finally {
            setSwitching(false);
        }
    };

    const addAddress = async () => {
        if (!newAddress || !newAddress.startsWith('0x')) {
            setMessage({ type: 'error', text: 'Enter a valid Ethereum address (0x...)' });
            return;
        }
        try {
            await apiPost(`/api/v1/collections/${selectedCollection}/roles`, { address: newAddress, action: 'grant', role: newRole });
            setMessage({ type: 'success', text: `Address ${newAddress.substring(0, 10)}... granted ${newRole === 1 ? 'Read' : 'Write'} access to ${selectedCollection}` });
            setNewAddress('');
            loadData();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        }
    };

    const removeAddress = async (addr: string) => {
        try {
            await apiPost(`/api/v1/collections/${selectedCollection}/roles`, { address: addr, action: 'revoke' });
            setMessage({ type: 'success', text: `Address access revoked from ${selectedCollection}` });
            loadData();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        }
    };

    return (
        <div className="fade-in">
            {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

            {/* Storage Mode */}
            <div className="card" style={{ marginBottom: 24 }}>
                <div className="card-header">
                    <div className="card-title">Collection Privacy</div>
                    <span className={`badge ${storageMode === 'private' ? 'badge-warning' : 'badge-success'}`}>
                        {storageMode.toUpperCase()}
                    </span>
                </div>

                {/* Collection Selector */}
                <div className="input-group" style={{ marginBottom: 16 }}>
                    <label className="label">Select Collection</label>
                    <select className="select" value={selectedCollection} onChange={e => setSelectedCollection(e.target.value)}>
                        {collections.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
                    <div style={{
                        padding: 20,
                        borderRadius: 'var(--radius-md)',
                        border: `2px solid ${storageMode === 'public' ? 'var(--accent-secondary)' : 'var(--border-primary)'}`,
                        background: storageMode === 'public' ? 'rgba(0,212,170,0.05)' : 'transparent',
                        cursor: 'pointer',
                    }}
                    onClick={() => handleModeSwitch('public')}
                    >
                        <div style={{ fontWeight: 700, marginBottom: 6, color: storageMode === 'public' ? 'var(--accent-secondary)' : 'var(--text-tertiary)' }}>Public</div>
                        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                            Data stored on-chain in plaintext. Readable by anyone. Fast and transparent.
                        </div>
                    </div>
                    <div style={{
                        padding: 20,
                        borderRadius: 'var(--radius-md)',
                        border: `2px solid ${storageMode === 'private' ? 'var(--accent-tertiary)' : 'var(--border-primary)'}`,
                        background: storageMode === 'private' ? 'rgba(255,107,157,0.05)' : 'transparent',
                        cursor: 'pointer',
                    }}
                    onClick={() => handleModeSwitch('private')}
                    >
                        <div style={{ fontWeight: 700, marginBottom: 6, color: storageMode === 'private' ? 'var(--accent-tertiary)' : 'var(--text-tertiary)' }}>Private (Encrypted)</div>
                        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                            AES-256-GCM encrypted. Only owner + whitelisted addresses can access. Keys shared via ECDH.
                        </div>
                    </div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 12 }}>
                    Click a mode to switch. No server restart needed — privacy is configured per-collection.
                </div>
            </div>

            {/* Whitelist Management */}
            <div className="card">
                <div className="card-header">
                    <div className="card-title">Access Control for &ldquo;{selectedCollection}&rdquo;</div>
                    <span className="badge badge-primary">{Object.keys(roles).length} addresses</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16 }}>
                    Granted addresses can read/write data in this private collection based on their role.
                    The owner address (gas station) is always fully authorized.
                </div>

                <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                    <input
                        className="input input-mono"
                        style={{ flex: 1 }}
                        value={newAddress}
                        onChange={e => setNewAddress(e.target.value)}
                        placeholder="0x... Ethereum address"
                    />
                    <select className="select" style={{ width: 120 }} value={newRole} onChange={e => setNewRole(Number(e.target.value))}>
                        <option value={1}>Read Only</option>
                        <option value={2}>Read / Write</option>
                    </select>
                    <button className="btn btn-primary" onClick={addAddress} disabled={!newAddress}>
                        <Icon name="plus" size={16} /> Grant
                    </button>
                </div>

                {Object.keys(roles).length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-state-text">No addresses granted access yet</div>
                    </div>
                ) : (
                    <div className="table-container">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>#</th>
                                    <th>Address</th>
                                    <th>Role</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {Object.entries(roles).map(([addr, role], i) => (
                                    <tr key={addr}>
                                        <td>{i + 1}</td>
                                        <td style={{ fontFamily: 'JetBrains Mono', fontSize: 13 }}>{addr}</td>
                                        <td>
                                            <span className={`badge ${role >= 2 ? 'badge-warning' : 'badge-primary'}`}>
                                                {role >= 2 ? 'WRITE' : 'READ'}
                                            </span>
                                        </td>
                                        <td>
                                            <button className="btn btn-sm btn-danger" onClick={() => removeAddress(addr)}>
                                                <Icon name="trash" size={14} /> Revoke
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Encryption Info */}
            <div className="card" style={{ marginTop: 24 }}>
                <div className="card-header">
                    <div className="card-title">Encryption Details</div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginTop: 12 }}>
                    <div style={{ padding: 16, background: 'rgba(131,110,249,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(131,110,249,0.1)' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: 'var(--accent-primary-light)' }}>AES-256-GCM</div>
                        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>Authenticated encryption. Every value is encrypted with a unique IV. Tamper detection via auth tag.</div>
                    </div>
                    <div style={{ padding: 16, background: 'rgba(0,212,170,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(0,212,170,0.1)' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: 'var(--accent-secondary)' }}>HKDF Key Derivation</div>
                        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>AES key derived from owner&apos;s Ethereum private key via HMAC-SHA256 (HKDF). Never stored on-chain.</div>
                    </div>
                    <div style={{ padding: 16, background: 'rgba(255,107,157,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(255,107,157,0.1)' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: 'var(--accent-tertiary)' }}>ECDH Key Sharing</div>
                        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>AES key shared with whitelisted addresses via Elliptic Curve Diffie-Hellman. Encrypted key share stored on-chain.</div>
                    </div>
                </div>
            </div>
        </div>
    );
}
