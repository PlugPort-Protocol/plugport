'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useAccount } from 'wagmi';
import { useContractDeployer, type DeployCostEstimate } from '@/lib/contract-deployer';
import { storeStatusView, describeMigration, type PrivateStoreStatus } from '@/lib/private-store';
import { describeLoadError } from '@/lib/load-status';

const EXPLORER = 'https://testnet.monadexplorer.com/address/';
const MIGRATION_POLL_MS = 3000;

function Address({ value }: { value: string }) {
    return (
        <a href={`${EXPLORER}${value}`} target="_blank" rel="noreferrer" style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
            {value}
        </a>
    );
}

/**
 * The customer's own private store (option B): one contract per wallet, owned
 * by the customer, holding their private collections. Deploying is optional;
 * without one, private collections use the shared private store.
 */
export function DeployTab() {
    const { isAuthenticated, ensureNetwork } = useAuth();
    const { isConnected } = useAccount();
    const factoryAddress = process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
    const { state: deployState, deployPrivateStore, estimateDeployCost, linkStore } = useContractDeployer(factoryAddress);
    const [status, setStatus] = useState<PrivateStoreStatus | null>(null);
    const [statusError, setStatusError] = useState<string | null>(null);
    const [cost, setCost] = useState<DeployCostEstimate | null>(null);
    const [costError, setCostError] = useState<string | null>(null);

    const loadStatus = useCallback(async () => {
        try {
            setStatus(await apiGet<PrivateStoreStatus>('/api/v1/deploy/private-store'));
            setStatusError(null);
        } catch (err) {
            setStatusError(describeLoadError(err));
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated) loadStatus();
    }, [isAuthenticated, loadStatus]);

    // Follow the move of existing private collections into a newly linked store.
    const moving = status?.migration?.state === 'running';
    useEffect(() => {
        if (!moving) return;
        const timer = setInterval(loadStatus, MIGRATION_POLL_MS);
        return () => clearInterval(timer);
    }, [moving, loadStatus]);

    const canDeploy = !!factoryAddress && !!status?.enabled && status.status === 'none';
    useEffect(() => {
        if (!canDeploy || !isConnected) return;
        estimateDeployCost()
            .then((c) => { setCost(c); setCostError(null); })
            .catch((err) => setCostError(err instanceof Error ? err.message : 'Could not estimate the cost'));
    }, [canDeploy, isConnected, estimateDeployCost]);

    const handleDeploy = async () => {
        await ensureNetwork();
        await deployPrivateStore();
        await loadStatus();
    };

    const handleRelink = async () => {
        if (deployState.contractAddress && await linkStore(deployState.contractAddress)) await loadStatus();
    };

    const stepLabels: Record<string, { label: string; color: string }> = {
        estimating: { label: 'Preparing…', color: 'var(--accent-info)' },
        deploying: { label: 'Approve the transaction in your wallet…', color: 'var(--accent-warning)' },
        confirming: { label: 'Waiting for Monad to confirm…', color: 'var(--accent-primary-light)' },
        registering: { label: 'Linking the store to your account…', color: 'var(--accent-primary-light)' },
        done: { label: 'Your store is deployed and linked.', color: 'var(--accent-success)' },
    };

    if (!isAuthenticated || !isConnected) {
        return (
            <div className="fade-in">
                <div className="card">
                    <div className="empty-state">
                        <div className="empty-state-title">Connect Wallet</div>
                        <div className="empty-state-text">Connect your wallet and sign in to see or deploy your private store.</div>
                    </div>
                </div>
            </div>
        );
    }

    const view = status ? storeStatusView(factoryAddress ? status : { ...status, enabled: false }) : null;
    const migrationText = describeMigration(status?.migration);
    const busy = ['estimating', 'deploying', 'confirming', 'registering'].includes(deployState.step);

    return (
        <div className="fade-in">
            <div className="card" style={{ marginBottom: 24 }}>
                <div className="card-header">
                    <div className="card-title">Your Private Store</div>
                    {status?.status === 'active' && <span className="badge badge-success">active</span>}
                    {status?.status === 'detached' && <span className="badge badge-error">cut off</span>}
                </div>

                {statusError && (
                    <div className="alert alert-error" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                        <div>Couldn&apos;t load your store status: {statusError}.</div>
                        <button className="btn btn-sm btn-secondary" onClick={loadStatus}>Retry</button>
                    </div>
                )}
                {!status && !statusError && <div className="loading-center"><div className="spinner" /></div>}

                {view && (
                    <div className={`alert alert-${view.tone}`} style={{ marginBottom: 16 }}>
                        <div style={{ fontWeight: 700, marginBottom: 4 }}>{view.title}</div>
                        <div>{view.detail}</div>
                    </div>
                )}

                {status?.store && (
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
                        Store: <Address value={status.store.address} /> · linked {new Date(status.store.linkedAt).toLocaleDateString()}
                    </div>
                )}
                {migrationText && (
                    <div className={`alert ${status?.migration?.state === 'failed' ? 'alert-error' : 'alert-info'}`} style={{ marginBottom: 12 }}>
                        {moving && <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2, display: 'inline-block', marginRight: 8, verticalAlign: 'middle' }} />}
                        {migrationText}
                    </div>
                )}

                {canDeploy && (
                    <>
                        <ul style={{ fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.7, margin: '0 0 16px', paddingLeft: 18 }}>
                            <li>One contract, owned by your wallet. All your private collections move into it.</li>
                            <li>You pay once to deploy it; PlugPort pays the gas for your reads and writes.</li>
                            <li>Data is encrypted before it is written. PlugPort holds the key so it can run queries for you.</li>
                            <li>You can cut PlugPort off at any time (transferGasStation); your data stays in your contract.</li>
                        </ul>
                        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
                            {cost
                                ? <>Estimated cost: <strong>{cost.costMon} MON</strong> at the current gas price, paid from your wallet.</>
                                : costError
                                    ? <span style={{ color: 'var(--accent-error)' }}>Couldn&apos;t estimate the cost: {costError}</span>
                                    : 'Estimating cost…'}
                        </div>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                            <button className="btn btn-primary" onClick={handleDeploy} disabled={busy}>
                                {busy ? 'Deploying…' : 'Deploy my private store'}
                            </button>
                            {stepLabels[deployState.step] && (
                                <span style={{ fontSize: 13, color: stepLabels[deployState.step].color }}>{stepLabels[deployState.step].label}</span>
                            )}
                        </div>
                    </>
                )}

                {deployState.step === 'unlinked' && deployState.contractAddress && (
                    <div className="alert alert-error" style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <div>
                            Your store <Address value={deployState.contractAddress} /> was deployed, but linking it to your account failed: {deployState.error}.
                            Until it is linked, your private data stays in the shared store.
                        </div>
                        <button className="btn btn-sm btn-secondary" onClick={handleRelink}>Retry linking</button>
                    </div>
                )}
                {deployState.step === 'error' && deployState.error && (
                    <div className="alert alert-error" style={{ marginTop: 16 }}>Deployment failed: {deployState.error}</div>
                )}
            </div>
        </div>
    );
}
