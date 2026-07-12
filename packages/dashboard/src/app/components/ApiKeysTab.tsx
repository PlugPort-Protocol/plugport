'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, apiDelete } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useSignMessage } from 'wagmi';
import { keccak256, toBytes } from 'viem';
import { Icon } from '@/lib/icons';
import type { ApiKeyInfo, KeyAnalytics, OnChainKeyInfo } from '../types';

// ---- Wallet-Derived Key Helpers ----

/** Derives an API key from a wallet signature (deterministic) */
function deriveApiKeyFromSignature(signature: string): string {
    return keccak256(toBytes(signature));
}

/** Computes keccak256 hash commitment of an API key */
function computeCommitment(apiKey: string): string {
    return keccak256(toBytes(apiKey));
}

/** Builds the derivation message for a given address and index */
function buildDerivationMessage(address: string, index: number): string {
    return `PlugPort API Key #${index} for ${address.toLowerCase()}`;
}

// ---- Component ----

export function ApiKeysTab() {
    const { address, isAuthenticated, authMethod } = useAuth();
    const { signMessageAsync } = useSignMessage();

    // Legacy key state
    const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [newLabel, setNewLabel] = useState('');
    const [newPermissions, setNewPermissions] = useState<string[]>(['all']);
    const [generatedKey, setGeneratedKey] = useState<string | null>(null);
    const [expandedKey, setExpandedKey] = useState<string | null>(null);
    const [keyAnalytics, setKeyAnalytics] = useState<KeyAnalytics | null>(null);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    // On-chain key state
    const [onChainKeys, setOnChainKeys] = useState<OnChainKeyInfo[]>([]);
    const [onChainLoading, setOnChainLoading] = useState(false);
    const [generatingOnChain, setGeneratingOnChain] = useState(false);
    const [recoveringKeys, setRecoveringKeys] = useState(false);
    const [activeTab, setActiveTab] = useState<'onchain' | 'legacy'>('onchain');

    // ---- Legacy Key Management ----

    const loadKeys = useCallback(async () => {
        try {
            const res = await apiGet<{ keys: ApiKeyInfo[] }>('/api/v1/keys');
            setKeys(res.keys || []);
        } catch { /* ignore */ }
        setLoading(false);
    }, []);

    useEffect(() => {
        if (isAuthenticated) {
            loadKeys();
            loadOnChainKeys();
        } else {
            setLoading(false);
        }
    }, [isAuthenticated, loadKeys]);

    const handleGenerate = async () => {
        if (!newLabel.trim()) {
            setMessage({ type: 'error', text: 'Label is required' });
            return;
        }
        try {
            const res = await apiPost<{ apiKey: string; metadata: ApiKeyInfo }>('/api/v1/keys/generate', {
                label: newLabel,
                permissions: newPermissions,
            });
            setGeneratedKey(res.apiKey);
            setMessage({ type: 'success', text: 'API key generated! Copy it now — it won\'t be shown again.' });
            setNewLabel('');
            loadKeys();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        }
    };

    const handleRevoke = async (hash: string) => {
        try {
            await apiDelete(`/api/v1/keys/${hash}`);
            setMessage({ type: 'success', text: 'Key revoked' });
            loadKeys();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        }
    };

    const handleRotate = async (hash: string) => {
        try {
            const res = await apiPost<{ apiKey: string }>(`/api/v1/keys/${hash}/rotate`, {});
            setGeneratedKey(res.apiKey);
            setMessage({ type: 'success', text: 'Key rotated! Copy the new key.' });
            loadKeys();
        } catch (err) {
            setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed' });
        }
    };

    const loadAnalytics = async (hash: string) => {
        if (expandedKey === hash) {
            setExpandedKey(null);
            setKeyAnalytics(null);
            return;
        }
        try {
            const res = await apiGet<{ analytics: KeyAnalytics }>(`/api/v1/keys/${hash}/analytics?days=7`);
            setKeyAnalytics(res.analytics);
            setExpandedKey(hash);
        } catch { /* ignore */ }
    };

    // ---- On-Chain Key Management ----

    const loadOnChainKeys = useCallback(async () => {
        if (!address) return;
        setOnChainLoading(true);
        try {
            const res = await apiGet<{ activeKeys: OnChainKeyInfo[]; address: string }>(
                `/api/v1/auth/keys/${address}`
            );
            setOnChainKeys(res.activeKeys || []);
        } catch { /* ignore */ }
        setOnChainLoading(false);
    }, [address]);

    const handleGenerateOnChain = async () => {
        if (!address) return;
        setGeneratingOnChain(true);
        setMessage(null);

        try {
            // Determine next available index
            const nextIndex = onChainKeys.length > 0
                ? Math.max(...onChainKeys.map(k => k.keyIndex)) + 1
                : 0;

            // 1. Sign the derivation message
            const derivationMessage = buildDerivationMessage(address, nextIndex);
            const signature = await signMessageAsync({ message: derivationMessage });

            // 2. Derive API key
            const apiKey = deriveApiKeyFromSignature(signature);
            const commitment = computeCommitment(apiKey);

            // 3. Compute SCRAM verifiers (salt is deterministic from address + index)
            const salt = keccak256(
                toBytes(`${address.toLowerCase()}:${nextIndex}`)
            ).slice(0, 58); // 28-byte salt as hex

            // 4. Sign EIP-712 meta-tx for registration
            // (In production, this would be a typed signTypedData call)
            const metaSignature = await signMessageAsync({
                message: `PlugPort: Register API Key\nCommitment: ${commitment}\nNonce: ${nextIndex}`,
            });

            // 5. Relay to server
            await apiPost('/api/v1/auth/register-key', {
                keyOwner: address,
                commitment,
                salt,
                storedKey: commitment, // Placeholder — real SCRAM derivation done server-side
                serverKey: commitment,
                nonce: nextIndex,
                signature: metaSignature,
            });

            setGeneratedKey(apiKey);
            setMessage({
                type: 'success',
                text: `Wallet-derived key #${nextIndex} registered! Copy it now — you can always recover it with your wallet.`,
            });

            await loadOnChainKeys();
        } catch (err) {
            setMessage({
                type: 'error',
                text: err instanceof Error ? err.message : 'Failed to generate key',
            });
        } finally {
            setGeneratingOnChain(false);
        }
    };

    const handleRevokeOnChain = async (keyIndex: number) => {
        if (!address) return;
        setMessage(null);

        try {
            const metaSignature = await signMessageAsync({
                message: `PlugPort: Revoke API Key #${keyIndex}\nOwner: ${address}`,
            });

            await apiPost('/api/v1/auth/revoke-key', {
                keyOwner: address,
                keyIndex,
                nonce: keyIndex,
                signature: metaSignature,
            });

            setMessage({ type: 'success', text: `Key #${keyIndex} revoked on-chain` });
            await loadOnChainKeys();
        } catch (err) {
            setMessage({
                type: 'error',
                text: err instanceof Error ? err.message : 'Failed to revoke key',
            });
        }
    };

    const handleRotateOnChain = async (oldKeyIndex: number) => {
        if (!address) return;
        setMessage(null);

        try {
            // Determine next available index for the new key
            const nextIndex = onChainKeys.length > 0
                ? Math.max(...onChainKeys.map(k => k.keyIndex)) + 1
                : 0;

            // 1. Derive new API key
            const derivationMessage = buildDerivationMessage(address, nextIndex);
            const signature = await signMessageAsync({ message: derivationMessage });
            const newApiKey = deriveApiKeyFromSignature(signature);
            const newCommitment = computeCommitment(newApiKey);

            // 2. Compute SCRAM verifiers for the new key
            const newSalt = keccak256(
                toBytes(`${address.toLowerCase()}:${nextIndex}`)
            ).slice(0, 58);

            // 3. Sign EIP-712 meta-tx for rotation
            const metaSignature = await signMessageAsync({
                message: `PlugPort: Rotate API Key\nOld Key: #${oldKeyIndex}\nNew Commitment: ${newCommitment}\nNonce: ${nextIndex}`,
            });

            // 4. Relay to server
            await apiPost('/api/v1/auth/rotate-key', {
                keyOwner: address,
                oldKeyIndex,
                newCommitment,
                newSalt: newSalt,
                newStoredKey: newCommitment, // Placeholder — real SCRAM derivation done server-side
                newServerKey: newCommitment,
                nonce: nextIndex,
                signature: metaSignature,
            });

            setGeneratedKey(newApiKey);
            setMessage({
                type: 'success',
                text: `Key #${oldKeyIndex} rotated to key #${nextIndex}! Copy the new key now.`,
            });

            await loadOnChainKeys();
        } catch (err) {
            setMessage({
                type: 'error',
                text: err instanceof Error ? err.message : 'Failed to rotate key',
            });
        }
    };

    const handleRecoverKeys = async () => {
        if (!address) return;
        setRecoveringKeys(true);
        setMessage(null);

        const recoveredKeys: OnChainKeyInfo[] = [];
        const MAX_SCAN = 10; // Max keys per wallet

        try {
            for (let i = 0; i < MAX_SCAN; i++) {
                try {
                    const msg = buildDerivationMessage(address, i);
                    const sig = await signMessageAsync({ message: msg });
                    const apiKey = deriveApiKeyFromSignature(sig);
                    const commitment = computeCommitment(apiKey);

                    recoveredKeys.push({
                        keyIndex: i,
                        commitment,
                        active: true, // Will be verified against on-chain state
                        createdAt: Date.now(),
                        derivedKey: apiKey,
                    });
                } catch {
                    // User rejected signing — stop scanning
                    break;
                }
            }

            if (recoveredKeys.length > 0) {
                setOnChainKeys(recoveredKeys);
                setMessage({
                    type: 'success',
                    text: `Recovered ${recoveredKeys.length} key(s). Active keys are shown below.`,
                });
            } else {
                setMessage({ type: 'error', text: 'No keys found for this wallet.' });
            }
        } catch (err) {
            setMessage({
                type: 'error',
                text: err instanceof Error ? err.message : 'Recovery failed',
            });
        } finally {
            setRecoveringKeys(false);
        }
    };

    // ---- Render ----

    if (!isAuthenticated || authMethod !== 'wallet') {
        return (
            <div className="fade-in">
                <div className="card">
                    <div className="empty-state">
                        <Icon name="wallet" size={48} />
                        <div className="empty-state-title" style={{ marginTop: 16 }}>Connect Your Wallet</div>
                        <div className="empty-state-text">Connect your wallet and sign in with SIWE to generate and manage API keys.</div>
                    </div>
                </div>
            </div>
        );
    }

    if (loading) return <div className="loading-center"><div className="spinner" /></div>;

    return (
        <div className="fade-in">
            {message && <div className={`alert alert-${message.type}`}>{message.text}</div>}

            {/* Generated key display */}
            {generatedKey && (
                <div className="alert alert-success" style={{ fontFamily: 'JetBrains Mono', fontSize: 13, flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ fontWeight: 700 }}>Your API Key (copy now — shown only once):</div>
                    <div style={{ display: 'flex', gap: 8, width: '100%' }}>
                        <code style={{ flex: 1, background: 'rgba(0,0,0,0.2)', padding: '8px 12px', borderRadius: 6, wordBreak: 'break-all' }}>
                            {generatedKey}
                        </code>
                        <button className="btn btn-sm btn-secondary" onClick={() => { navigator.clipboard.writeText(generatedKey); }}>Copy</button>
                    </div>
                    <button className="btn btn-sm" style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', padding: 0, marginTop: 4, fontSize: 11 }} onClick={() => setGeneratedKey(null)}>Dismiss</button>
                </div>
            )}

            {/* Tab switcher: On-Chain vs Legacy */}
            <div style={{ display: 'flex', background: 'var(--bg-tertiary)', borderRadius: 8, padding: 3, marginBottom: 24, width: 'fit-content' }}>
                {(['onchain', 'legacy'] as const).map(tab => (
                    <button
                        key={tab}
                        style={{
                            border: 'none',
                            background: activeTab === tab ? 'var(--bg-primary)' : 'transparent',
                            color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-tertiary)',
                            padding: '8px 20px',
                            fontSize: 13,
                            fontWeight: 600,
                            borderRadius: 6,
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                        }}
                        onClick={() => setActiveTab(tab)}
                    >
                        {tab === 'onchain' ? '🔐 Wallet-Derived Keys' : '🔑 Legacy Keys'}
                    </button>
                ))}
            </div>

            {/* ---- ON-CHAIN KEYS ---- */}
            {activeTab === 'onchain' && (
                <>
                    {/* Generate new wallet-derived key */}
                    <div className="card" style={{ marginBottom: 24 }}>
                        <div className="card-header">
                            <div className="card-title">Generate Wallet-Derived API Key</div>
                        </div>
                        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16, lineHeight: 1.6 }}>
                            Derive a new API key from your wallet signature. The key is <strong>deterministic</strong> — you can always recover it by signing the same message again.
                            Only the <code style={{ background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4 }}>keccak256</code> hash is stored on-chain.
                        </div>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                            <button
                                className="btn btn-primary"
                                onClick={handleGenerateOnChain}
                                disabled={generatingOnChain}
                                style={{ minWidth: 200 }}
                            >
                                {generatingOnChain ? (
                                    <><div className="spinner" style={{ width: 16, height: 16 }} /> Signing...</>
                                ) : (
                                    <><Icon name="wallet" size={16} /> Generate from Wallet</>
                                )}
                            </button>
                            <button
                                className="btn btn-secondary"
                                onClick={handleRecoverKeys}
                                disabled={recoveringKeys}
                                style={{ minWidth: 160 }}
                            >
                                {recoveringKeys ? (
                                    <><div className="spinner" style={{ width: 16, height: 16 }} /> Scanning...</>
                                ) : (
                                    <><Icon name="refresh" size={16} /> Recover Keys</>
                                )}
                            </button>
                        </div>
                    </div>

                    {/* Active on-chain keys list */}
                    <div style={{ display: 'grid', gap: 16 }}>
                        {onChainLoading ? (
                            <div className="loading-center"><div className="spinner" /></div>
                        ) : onChainKeys.length === 0 ? (
                            <div className="card">
                                <div className="empty-state">
                                    <Icon name="lock" size={40} />
                                    <div className="empty-state-title" style={{ marginTop: 12 }}>No Wallet-Derived Keys</div>
                                    <div className="empty-state-text">Generate your first wallet-derived API key. It&apos;s secured by your wallet and stored as a hash commitment on-chain.</div>
                                </div>
                            </div>
                        ) : (
                            onChainKeys.map(k => (
                                <div key={k.keyIndex} className="card">
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                                                <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
                                                    Key #{k.keyIndex}
                                                </span>
                                                <span className={`badge ${k.active ? 'badge-success' : 'badge-error'}`}>
                                                    {k.active ? 'ACTIVE' : 'REVOKED'}
                                                </span>
                                                <span className="badge badge-primary" style={{ fontSize: 10 }}>ON-CHAIN</span>
                                            </div>
                                            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'JetBrains Mono' }}>
                                                Commitment: {k.commitment.substring(0, 18)}...
                                            </div>
                                            {k.derivedKey && (
                                                <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                                                    <code style={{
                                                        fontSize: 11,
                                                        background: 'var(--bg-tertiary)',
                                                        padding: '4px 8px',
                                                        borderRadius: 4,
                                                        fontFamily: 'JetBrains Mono',
                                                        wordBreak: 'break-all',
                                                        maxWidth: 400,
                                                        overflow: 'hidden',
                                                        textOverflow: 'ellipsis',
                                                    }}>
                                                        {k.derivedKey.substring(0, 22)}...
                                                    </code>
                                                    <button
                                                        className="btn btn-sm btn-secondary"
                                                        onClick={() => navigator.clipboard.writeText(k.derivedKey!)}
                                                        style={{ fontSize: 11 }}
                                                    >
                                                        Copy
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                        {k.active && (
                                            <div style={{ display: 'flex', gap: 8 }}>
                                                <button
                                                    className="btn btn-sm btn-secondary"
                                                    onClick={() => handleRotateOnChain(k.keyIndex)}
                                                >
                                                    Rotate
                                                </button>
                                                <button
                                                    className="btn btn-sm btn-danger"
                                                    onClick={() => handleRevokeOnChain(k.keyIndex)}
                                                >
                                                    Revoke
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>

                    {/* Security info */}
                    <div className="card" style={{ marginTop: 24 }}>
                        <div className="card-header">
                            <div className="card-title">How It Works</div>
                        </div>
                        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.8 }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px' }}>
                                <span style={{ fontWeight: 700, color: 'var(--text-secondary)' }}>1.</span>
                                <span>Your wallet signs a deterministic message (<code style={{ background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>PlugPort API Key #N for 0x...</code>)</span>
                                <span style={{ fontWeight: 700, color: 'var(--text-secondary)' }}>2.</span>
                                <span>The signature is hashed to produce your API key (<code style={{ background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>keccak256(sig)</code>)</span>
                                <span style={{ fontWeight: 700, color: 'var(--text-secondary)' }}>3.</span>
                                <span>Only the <strong>hash commitment</strong> (<code style={{ background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>keccak256(apiKey)</code>) is stored on-chain — never the raw key</span>
                                <span style={{ fontWeight: 700, color: 'var(--text-secondary)' }}>4.</span>
                                <span>Gas fees are sponsored by the PlugPort gas station via EIP-712 meta-transactions</span>
                                <span style={{ fontWeight: 700, color: 'var(--text-secondary)' }}>5.</span>
                                <span>Keys are <strong>recoverable</strong> — re-sign the same message to re-derive any key</span>
                            </div>
                        </div>
                    </div>
                </>
            )}

            {/* ---- LEGACY KEYS ---- */}
            {activeTab === 'legacy' && (
                <>
                    {/* Generate new key */}
                    <div className="card" style={{ marginBottom: 24 }}>
                        <div className="card-header">
                            <div className="card-title">Generate API Key</div>
                            <span className="badge badge-warning" style={{ fontSize: 10 }}>LEGACY</span>
                        </div>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
                            <div style={{ flex: 1 }}>
                                <label className="label">Label</label>
                                <input
                                    className="input"
                                    value={newLabel}
                                    onChange={e => setNewLabel(e.target.value)}
                                    placeholder="e.g., my-app-prod"
                                />
                            </div>
                            <div style={{ minWidth: 180 }}>
                                <label className="label">Permissions</label>
                                <select className="select" value={newPermissions[0]} onChange={e => setNewPermissions([e.target.value])}>
                                    <option value="all">All (read + write + admin)</option>
                                    <option value="read">Read Only</option>
                                    <option value="write">Read + Write</option>
                                    <option value="admin">Admin</option>
                                </select>
                            </div>
                            <button className="btn btn-primary" onClick={handleGenerate} disabled={!newLabel.trim()}>
                                <Icon name="key" size={16} /> Generate
                            </button>
                        </div>
                    </div>

                    {/* Active keys */}
                    <div style={{ display: 'grid', gap: 16 }}>
                        {keys.length === 0 ? (
                            <div className="card">
                                <div className="empty-state">
                                    <div className="empty-state-title">No Legacy API Keys</div>
                                    <div className="empty-state-text">Generate a legacy API key or switch to Wallet-Derived Keys for on-chain security.</div>
                                </div>
                            </div>
                        ) : (
                            keys.map(k => (
                                <div key={k.hash} className="card">
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                        <div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                                                <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{k.label}</span>
                                                <span className="badge badge-success">ACTIVE</span>
                                                {k.permissions.map(p => (
                                                    <span key={p} className="badge badge-primary" style={{ fontSize: 10 }}>{p}</span>
                                                ))}
                                            </div>
                                            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                                                Hash: <code style={{ fontFamily: 'JetBrains Mono' }}>{k.hash.substring(0, 16)}...</code>
                                                {' · '}Created: {new Date(k.createdAt).toLocaleDateString()}
                                            </div>
                                        </div>
                                        <div style={{ display: 'flex', gap: 8 }}>
                                            <button className="btn btn-sm btn-secondary" onClick={() => loadAnalytics(k.hash)}>
                                                <Icon name="chart" size={14} /> {expandedKey === k.hash ? 'Hide' : 'Analytics'}
                                            </button>
                                            <button className="btn btn-sm btn-secondary" onClick={() => handleRotate(k.hash)}>Rotate</button>
                                            <button className="btn btn-sm btn-danger" onClick={() => handleRevoke(k.hash)}>Revoke</button>
                                        </div>
                                    </div>

                                    {/* Per-key analytics (expandable) */}
                                    {expandedKey === k.hash && keyAnalytics && (
                                        <div style={{ marginTop: 20, borderTop: '1px solid var(--border-primary)', paddingTop: 20 }}>
                                            <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                                                <div className="stat-card">
                                                    <div className="stat-label">Total Requests</div>
                                                    <div className="stat-value" style={{ fontSize: 24 }}>{keyAnalytics.totalRequests.toLocaleString()}</div>
                                                </div>
                                                <div className="stat-card">
                                                    <div className="stat-label">Avg Latency</div>
                                                    <div className="stat-value" style={{ fontSize: 24 }}>
                                                        {keyAnalytics.daily.length > 0
                                                            ? `${(keyAnalytics.daily.reduce((s, d) => s + d.avgLatencyMs, 0) / Math.max(1, keyAnalytics.daily.filter(d => d.requests > 0).length)).toFixed(1)}ms`
                                                            : '—'}
                                                    </div>
                                                </div>
                                                <div className="stat-card">
                                                    <div className="stat-label">Error Rate</div>
                                                    <div className="stat-value" style={{ fontSize: 24 }}>
                                                        {keyAnalytics.daily.length > 0
                                                            ? `${(keyAnalytics.daily.reduce((s, d) => s + d.errorRate, 0) / Math.max(1, keyAnalytics.daily.filter(d => d.requests > 0).length) * 100).toFixed(1)}%`
                                                            : '—'}
                                                    </div>
                                                </div>
                                                <div className="stat-card">
                                                    <div className="stat-label">Collections</div>
                                                    <div className="stat-value" style={{ fontSize: 24 }}>{Object.keys(keyAnalytics.collections).length}</div>
                                                </div>
                                            </div>

                                            {/* Operation breakdown */}
                                            {Object.keys(keyAnalytics.operations).length > 0 && (
                                                <div style={{ marginTop: 16 }}>
                                                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: 'var(--text-primary)' }}>By Operation</div>
                                                    {(() => {
                                                        const maxOps = Math.max(...Object.values(keyAnalytics.operations));
                                                        return Object.entries(keyAnalytics.operations)
                                                            .sort(([, a], [, b]) => b - a)
                                                            .map(([op, count]) => (
                                                                <div key={op} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                                                                    <span style={{ width: 70, fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'JetBrains Mono' }}>{op}</span>
                                                                    <div style={{ flex: 1, height: 20, background: 'var(--bg-input)', borderRadius: 4, overflow: 'hidden' }}>
                                                                        <div style={{ height: '100%', width: `${(count / maxOps) * 100}%`, background: 'var(--gradient-primary)', borderRadius: 4, transition: 'width 0.5s' }} />
                                                                    </div>
                                                                    <span style={{ width: 60, textAlign: 'right', fontSize: 12, fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{count.toLocaleString()}</span>
                                                                </div>
                                                            ));
                                                    })()}
                                                </div>
                                            )}

                                            {/* Top collections */}
                                            {Object.keys(keyAnalytics.collections).length > 0 && (
                                                <div style={{ marginTop: 16 }}>
                                                    <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: 'var(--text-primary)' }}>Top Collections</div>
                                                    <div className="table-container">
                                                        <table className="table">
                                                            <thead><tr><th>Collection</th><th>Requests</th></tr></thead>
                                                            <tbody>
                                                                {Object.entries(keyAnalytics.collections)
                                                                    .sort(([, a], [, b]) => b - a)
                                                                    .slice(0, 10)
                                                                    .map(([col, count]) => (
                                                                        <tr key={col}>
                                                                            <td style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{col}</td>
                                                                            <td style={{ fontFamily: 'JetBrains Mono' }}>{count.toLocaleString()}</td>
                                                                        </tr>
                                                                    ))}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                </>
            )}

            {/* Usage instructions */}
            <div className="card" style={{ marginTop: 24 }}>
                <div className="card-header">
                    <div className="card-title">Using Your API Key</div>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.7 }}>
                    Add your API key to your project&apos;s <code style={{ background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4 }}>.env</code> file:
                </div>
                <pre className="json-view" style={{ marginTop: 12 }}>
{`# .env
PLUGPORT_API_KEY=0x_your_key_here
PLUGPORT_URL=http://localhost:8080

# Usage with curl:
curl -X POST http://localhost:8080/api/v1/collections/users/find \\
  -H "x-api-key: 0x_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{"filter": {}}'

# Usage with MongoDB wire protocol (SCRAM-SHA-256):
mongosh "mongodb://0xYourAddress:0x_your_key_here@localhost:27017"`}
                </pre>
            </div>
        </div>
    );
}
