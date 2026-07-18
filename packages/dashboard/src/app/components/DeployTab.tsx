'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useAccount } from 'wagmi';
import { useContractDeployer, type GasStationInfo } from '@/lib/contract-deployer';

export function DeployTab() {
    const { address, isAuthenticated } = useAuth();
    const { isConnected } = useAccount();
    const factoryAddress = process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
    const { state: deployState, deployPrivateStore, getGasStationInfo, getDeployedStores, reset } = useContractDeployer(factoryAddress);
    const [deployedContracts, setDeployedContracts] = useState<Array<{ contractAddress: string; contractType: string; createdAt: number }>>([]);
    const [loadingContracts, setLoadingContracts] = useState(true);

    useEffect(() => {
        if (!isAuthenticated) return;
        let mounted = true;
        apiGet<{ contracts: any[] }>('/api/v1/deploy/contracts')
            .then(res => {
                if (mounted) {
                    setDeployedContracts(res.contracts || []);
                    setLoadingContracts(false);
                }
            })
            .catch(() => {
                if (mounted) setLoadingContracts(false);
            });
        return () => { mounted = false; };
    }, [isAuthenticated]);

    const handleDeploy = async () => {
        const result = await deployPrivateStore();
        if (result) {
            // Refresh contracts list
            try {
                const res = await apiGet<{ contracts: Array<{ contractAddress: string; contractType: string; createdAt: number }> }>('/api/v1/deploy/contracts');
                setDeployedContracts(res.contracts);
            } catch {}
        }
    };

    const stepLabels: Record<string, { label: string; color: string }> = {
        idle: { label: 'Ready', color: 'var(--text-tertiary)' },
        estimating: { label: 'Estimating gas...', color: 'var(--accent-info)' },
        deploying: { label: 'Awaiting wallet signature...', color: 'var(--accent-warning)' },
        confirming: { label: 'Confirming on-chain...', color: 'var(--accent-primary-light)' },
        registering: { label: 'Registering with server...', color: 'var(--accent-primary-light)' },
        done: { label: 'Deployed successfully!', color: 'var(--accent-success)' },
        error: { label: 'Deployment failed', color: 'var(--accent-error)' },
    };

    if (!isAuthenticated || !isConnected) {
        return (
            <div className="fade-in">
                <div className="card">
                    <div className="empty-state">
                        <div className="empty-state-title">Connect Wallet</div>
                        <div className="empty-state-text">Connect your wallet and sign in to deploy contracts and manage gas stations.</div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="fade-in">
            {/* Deployment Wizard */}
            <div className="card" style={{ marginBottom: 24 }}>
                <div className="card-header">
                    <div className="card-title">Deploy Private Store</div>
                    <span className="badge badge-primary">via Factory Contract</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20, lineHeight: 1.6 }}>
                    Deploy a new <code style={{ background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4 }}>PlugPortPrivateStore</code> contract
                    for encrypted, access-controlled data. Each private collection uses its own contract instance.
                </div>

                {/* PlugPort Subsidized Badge */}
                <div style={{
                    padding: 16,
                    borderRadius: 'var(--radius-md)',
                    background: 'rgba(0,212,170,0.05)',
                    border: '1px solid rgba(0,212,170,0.2)',
                    marginBottom: 20,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12
                }}>
                    <div style={{ fontSize: 24 }}>✨</div>
                    <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent-secondary)' }}>
                            PlugPort Subsidized
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
                            You don't need to provide a gas station. PlugPort sponsors all transaction fees for your Private Store.
                        </div>
                    </div>
                </div>

                {/* Deploy button + status */}
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <button
                        className="btn btn-primary"
                        onClick={handleDeploy}
                        disabled={deployState.step === 'deploying' || deployState.step === 'confirming' || deployState.step === 'registering'}
                    >
                        {deployState.step === 'idle' || deployState.step === 'done' || deployState.step === 'error'
                            ? '🚀 Deploy Contract'
                            : '⏳ Deploying...'
                        }
                    </button>
                    {deployState.step !== 'idle' && (
                        <span style={{ fontSize: 13, color: stepLabels[deployState.step]?.color || 'var(--text-tertiary)' }}>
                            {stepLabels[deployState.step]?.label}
                        </span>
                    )}
                    {deployState.step === 'done' && (
                        <button className="btn btn-secondary btn-sm" onClick={reset}>Deploy Another</button>
                    )}
                </div>

                {/* Deployment result */}
                {deployState.step === 'done' && deployState.contractAddress && (
                    <div style={{ marginTop: 16, padding: 16, background: 'rgba(0,212,170,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(0,212,170,0.2)' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent-success)', marginBottom: 8 }}>✅ Contract Deployed</div>
                        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
                            <strong>Address:</strong> <code style={{ fontFamily: 'JetBrains Mono', background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4 }}>{deployState.contractAddress}</code>
                        </div>
                        {deployState.txHash && (
                            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                                <strong>Tx Hash:</strong> <code style={{ fontFamily: 'JetBrains Mono', background: 'var(--bg-tertiary)', padding: '2px 6px', borderRadius: 4 }}>{deployState.txHash.substring(0, 20)}...</code>
                            </div>
                        )}
                    </div>
                )}

                {deployState.step === 'error' && deployState.error && (
                    <div className="alert alert-error" style={{ marginTop: 16 }}>{deployState.error}</div>
                )}
            </div>

            {/* Deployed Contracts */}
            <div className="card">
                <div className="card-header">
                    <div className="card-title">My Deployed Contracts</div>
                    <span className="badge badge-primary">{deployedContracts.length} contracts</span>
                </div>
                {loadingContracts ? (
                    <div className="loading-center"><div className="spinner" /></div>
                ) : deployedContracts.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-state-text">No contracts deployed yet. Use the wizard above to deploy your first private store.</div>
                    </div>
                ) : (
                    <div className="table-container">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Contract Address</th>
                                    <th>Type</th>
                                    <th>Deployed</th>
                                </tr>
                            </thead>
                            <tbody>
                                {deployedContracts.map(c => (
                                    <tr key={c.contractAddress}>
                                        <td style={{ fontFamily: 'JetBrains Mono', color: 'var(--text-primary)', fontSize: 12 }}>
                                            {c.contractAddress.substring(0, 14)}...{c.contractAddress.substring(38)}
                                        </td>
                                        <td><span className={`badge ${c.contractType === 'privateStore' ? 'badge-warning' : 'badge-primary'}`}>{c.contractType}</span></td>
                                        <td style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{new Date(c.createdAt).toLocaleDateString()}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
