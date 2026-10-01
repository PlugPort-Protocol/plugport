'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Icon } from '@/lib/icons';
import { describeSwitch, ownsCollection, type MigrationEstimate } from '@/lib/private-store';
import type { CollectionInfo } from '../types';

type Mode = 'public' | 'private';
interface PrivacyRecord { mode: Mode; accessRoles: Record<string, number>; storeAddress?: string }

/** Privacy settings for the collections the connected wallet owns. */
export function PrivacyTab({ collections }: { collections: CollectionInfo[] }) {
    const { address } = useAuth();
    const owned = collections.filter((c) => ownsCollection(c, address));
    const [selectedCollection, setSelectedCollection] = useState(owned[0]?.name || '');
    const [privacy, setPrivacy] = useState<PrivacyRecord | null>(null);
    const [newAddress, setNewAddress] = useState('');
    const [newRole, setNewRole] = useState<number>(1);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [switching, setSwitching] = useState(false);
    /** A switch the server wants confirmed, with what it will move. */
    const [pending, setPending] = useState<{ mode: Mode; estimate: MigrationEstimate } | null>(null);

    useEffect(() => {
        if (!selectedCollection && owned[0]) setSelectedCollection(owned[0].name);
    }, [owned, selectedCollection]);

    const loadData = useCallback(async () => {
        if (!selectedCollection) return;
        try {
            const res = await apiGet<{ privacy: PrivacyRecord | null }>(`/api/v1/collections/${selectedCollection}/privacy`);
            setPrivacy(res.privacy);
        } catch (err) {
            setPrivacy(null);
            setMessage({ type: 'error', text: `Couldn't load privacy settings: ${err instanceof Error ? err.message : 'request failed'}` });
        }
    }, [selectedCollection]);

    useEffect(() => { setPending(null); loadData(); }, [loadData]);

    const mode: Mode = privacy?.mode ?? 'public';

    const switchMode = async (target: Mode, confirm = false) => {
        if (!selectedCollection || (target === mode && !confirm)) return;
        setSwitching(true);
        setMessage(null);
        try {
            const res = await apiPost<{ migrated?: number }>(`/api/v1/collections/${selectedCollection}/privacy`, { mode: target, ...(confirm ? { confirm: true } : {}) });
            setPending(null);
            setMessage({ type: 'success', text: `${selectedCollection} is now ${target}${res.migrated ? ` (${res.migrated} entries moved)` : ''}.` });
            await loadData();
        } catch (err) {
            if (err instanceof ApiError && err.status === 409 && err.body?.estimate) {
                setPending({ mode: target, estimate: err.body.estimate as MigrationEstimate });
            } else if (err instanceof ApiError && err.status === 503) {
                setMessage({ type: 'error', text: `${selectedCollection} is busy (being moved). Try again shortly.` });
            } else {
                setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to switch' });
            }
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
            setMessage({ type: 'success', text: `${newAddress.substring(0, 10)}… can now ${newRole === 1 ? 'read' : 'read and write'} ${selectedCollection}` });
            setNewAddress('');
            loadData();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        }
    };

    const removeAddress = async (addr: string) => {
        try {
            await apiPost(`/api/v1/collections/${selectedCollection}/roles`, { address: addr, action: 'revoke' });
            setMessage({ type: 'success', text: `Access revoked from ${selectedCollection}` });
            loadData();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        }
    };

    if (owned.length === 0) {
        return (
            <div className="fade-in">
                <div className="card">
                    <div className="empty-state">
                        <div className="empty-state-title">No collections of yours yet</div>
                        <div className="empty-state-text">Privacy settings are available for collections you own. New collections you create are private by default.</div>
                    </div>
                </div>
            </div>
        );
    }

    const roles = privacy?.accessRoles ?? {};
    const storedIn = mode === 'public'
        ? 'the public store (readable by anyone)'
        : privacy?.storeAddress ? `your private store ${privacy.storeAddress}` : 'the shared private store';

    const modeCard = (target: Mode, title: string, text: string, accent: string, tint: string) => (
        <div
            style={{
                padding: 20,
                borderRadius: 'var(--radius-md)',
                border: `2px solid ${mode === target ? accent : 'var(--border-primary)'}`,
                background: mode === target ? tint : 'transparent',
                cursor: switching ? 'wait' : 'pointer',
            }}
            onClick={() => !switching && switchMode(target)}
        >
            <div style={{ fontWeight: 700, marginBottom: 6, color: mode === target ? accent : 'var(--text-tertiary)' }}>{title}</div>
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{text}</div>
        </div>
    );

    return (
        <div className="fade-in">
            {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

            <div className="card" style={{ marginBottom: 24 }}>
                <div className="card-header">
                    <div className="card-title">Collection Privacy</div>
                    <span className={`badge ${mode === 'private' ? 'badge-warning' : 'badge-success'}`}>{mode.toUpperCase()}</span>
                </div>

                <div className="input-group" style={{ marginBottom: 16 }}>
                    <label className="label">Your collections</label>
                    <select className="select" value={selectedCollection} onChange={(e) => setSelectedCollection(e.target.value)}>
                        {owned.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>Stored in {storedIn}.</div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    {modeCard('public', 'Public', 'Stored in plaintext on-chain. Anyone can read it, and it stays in the chain history.', 'var(--accent-secondary)', 'rgba(0,212,170,0.05)')}
                    {modeCard('private', 'Private (encrypted)', 'AES-256-GCM encrypted, in your own store if you have one. Only you and wallets you grant can read it.', 'var(--accent-tertiary)', 'rgba(255,107,157,0.05)')}
                </div>

                {pending && (
                    <div className="alert alert-info" style={{ marginTop: 16 }}>
                        <div style={{ fontWeight: 700, marginBottom: 6 }}>Switch {selectedCollection} to {pending.mode}?</div>
                        <ul style={{ margin: '0 0 12px', paddingLeft: 18, lineHeight: 1.6 }}>
                            {describeSwitch(selectedCollection, pending.mode, pending.estimate).map((line) => <li key={line}>{line}</li>)}
                        </ul>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button className="btn btn-sm btn-primary" disabled={switching} onClick={() => switchMode(pending.mode, true)}>
                                {switching ? 'Moving…' : `Switch to ${pending.mode}`}
                            </button>
                            <button className="btn btn-sm btn-secondary" disabled={switching} onClick={() => setPending(null)}>Cancel</button>
                        </div>
                    </div>
                )}
            </div>

            <div className="card">
                <div className="card-header">
                    <div className="card-title">Access for &ldquo;{selectedCollection}&rdquo;</div>
                    <span className="badge badge-primary">{Object.keys(roles).length} addresses</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16 }}>
                    You always have full access as the owner. Grant other wallets read or read/write access.
                </div>

                <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                    <input className="input input-mono" style={{ flex: 1 }} value={newAddress} onChange={(e) => setNewAddress(e.target.value)} placeholder="0x... wallet address" />
                    <select className="select" style={{ width: 170, flexShrink: 0 }} value={newRole} onChange={(e) => setNewRole(Number(e.target.value))}>
                        <option value={1}>Read Only</option>
                        <option value={2}>Read / Write</option>
                    </select>
                    <button className="btn btn-primary" onClick={addAddress} disabled={!newAddress}>
                        <Icon name="plus" size={16} /> Grant
                    </button>
                </div>

                {Object.keys(roles).length === 0 ? (
                    <div className="empty-state"><div className="empty-state-text">No other wallets have access</div></div>
                ) : (
                    <div className="table-container">
                        <table className="table">
                            <thead><tr><th>#</th><th>Address</th><th>Role</th><th>Actions</th></tr></thead>
                            <tbody>
                                {Object.entries(roles).map(([addr, role], i) => (
                                    <tr key={addr}>
                                        <td>{i + 1}</td>
                                        <td style={{ fontFamily: 'JetBrains Mono', fontSize: 13 }}>{addr}</td>
                                        <td><span className={`badge ${role >= 2 ? 'badge-warning' : 'badge-primary'}`}>{role >= 2 ? 'WRITE' : 'READ'}</span></td>
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

            {/* What "private" means here — kept to what the server actually does. */}
            <div className="card" style={{ marginTop: 24 }}>
                <div className="card-header"><div className="card-title">How private collections are protected</div></div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginTop: 12 }}>
                    <div style={{ padding: 16, background: 'rgba(131,110,249,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(131,110,249,0.1)' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: 'var(--accent-primary-light)' }}>AES-256-GCM</div>
                        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>Every document is encrypted with a unique IV before it is written, with tamper detection. On-chain it is unreadable.</div>
                    </div>
                    <div style={{ padding: 16, background: 'rgba(0,212,170,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(0,212,170,0.1)' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: 'var(--accent-secondary)' }}>Keys held by PlugPort</div>
                        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>PlugPort holds the encryption key so it can run your queries and indexes. Each private store has its own derived key.</div>
                    </div>
                    <div style={{ padding: 16, background: 'rgba(255,107,157,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(255,107,157,0.1)' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: 'var(--accent-tertiary)' }}>Hidden metadata</div>
                        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>A private collection&apos;s name, size, index fields, owner and access list are sealed too. Only encrypted records are visible on-chain.</div>
                    </div>
                </div>
            </div>
        </div>
    );
}
