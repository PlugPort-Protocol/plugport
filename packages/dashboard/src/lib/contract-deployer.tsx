'use client';

import { useState, useCallback } from 'react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { parseEther, formatEther, type Hash, type Address } from 'viem';
import { apiPost, apiGet } from './api';

// ---- Contract ABIs (minimal) ----

/** PlugPortPrivateStoreFactory ABI (deploy + query) */
const FACTORY_ABI = [
    {
        name: 'createPrivateStore',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'gasStation', type: 'address' }],
        outputs: [{ name: '', type: 'address' }],
    },
    {
        name: 'getStoresByOwner',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'owner', type: 'address' }],
        outputs: [{ name: '', type: 'address[]' }],
    },
    {
        name: 'getStoreCount',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'owner', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
    },
] as const;

// ---- Types ----

export type DeploymentStep = 'idle' | 'estimating' | 'deploying' | 'confirming' | 'registering' | 'done' | 'error' | 'unlinked';

export interface DeploymentState {
    step: DeploymentStep;
    txHash?: string;
    contractAddress?: string;
    error?: string;
}

/** What deploying a store will cost the customer, at the current gas price. */
export interface DeployCostEstimate {
    gasLimit: bigint;
    /** Monad charges for the gas limit, not the gas used. */
    costWei: bigint;
    costMon: string;
}

/** Gas limit = estimate + 20%; the cost estimate and the transaction use the same one. */
const withBuffer = (gas: bigint) => gas + gas / 5n;

export interface GasStationInfo {
    address: string;
    balance: string;
    balanceWei: bigint;
    estimatedOps: number;
    isLow: boolean;
}

// ---- Hook: useContractDeployer ----

/**
 * React hook for deploying PlugPort contracts and managing gas stations.
 * Handles the full lifecycle: estimate → deploy → confirm → register with server.
 */
export function useContractDeployer(factoryAddress?: string) {
    const publicClient = usePublicClient();
    const { data: walletClient } = useWalletClient();
    const [state, setState] = useState<DeploymentState>({ step: 'idle' });

    const fetchWriter = async (): Promise<string> => {
        const res = await apiGet<{ address: string }>('/api/v1/deploy/system-gas-station');
        if (!res.address) throw new Error('The server did not return PlugPort\'s writer address');
        return res.address;
    };

    /** The customer's cost to deploy, at the current gas price. */
    const estimateDeployCost = useCallback(async (): Promise<DeployCostEstimate | null> => {
        if (!walletClient || !publicClient || !factoryAddress) return null;
        const writer = await fetchWriter();
        const gasLimit = withBuffer(await publicClient.estimateContractGas({
            address: factoryAddress as Address,
            abi: FACTORY_ABI,
            functionName: 'createPrivateStore',
            args: [writer as Address],
            account: walletClient.account,
        }));
        const costWei = gasLimit * await publicClient.getGasPrice();
        return { gasLimit, costWei, costMon: Number(formatEther(costWei)).toFixed(3) };
    }, [walletClient, publicClient, factoryAddress]);

    /** Retry linking a deployed store to this wallet (after a failed registration). */
    const linkStore = useCallback(async (contractAddress: string) => {
        setState((prev) => ({ ...prev, step: 'registering', error: undefined }));
        try {
            await apiPost('/api/v1/deploy/register', { contractAddress, contractType: 'privateStore' });
            setState((prev) => ({ ...prev, step: 'done', contractAddress }));
            return true;
        } catch (err) {
            setState((prev) => ({ ...prev, step: 'unlinked', contractAddress, error: err instanceof Error ? err.message : 'Linking failed' }));
            return false;
        }
    }, []);

    /**
     * Deploy a new PlugPortPrivateStore via the factory contract, owned by the
     * connected wallet, and link it to that wallet on the server.
     */
    const deployPrivateStore = useCallback(async () => {
        if (!walletClient || !publicClient || !factoryAddress) {
            setState({ step: 'error', error: 'Wallet not connected or factory address not configured' });
            return null;
        }

        try {
            // PlugPort's writer becomes the store's gas station: it writes (and
            // reads) the customer's private data, and PlugPort pays its gas.
            setState({ step: 'estimating' });
            const writer = await fetchWriter();
            const gasLimit = withBuffer(await publicClient.estimateContractGas({
                address: factoryAddress as Address,
                abi: FACTORY_ABI,
                functionName: 'createPrivateStore',
                args: [writer as Address],
                account: walletClient.account,
            }));

            setState({ step: 'deploying' });
            const txHash = await walletClient.writeContract({
                address: factoryAddress as Address,
                abi: FACTORY_ABI,
                functionName: 'createPrivateStore',
                args: [writer as Address],
                gas: gasLimit,
            });

            setState({ step: 'confirming', txHash });
            const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
            if (receipt.status !== 'success') throw new Error(`The deploy transaction reverted (${txHash})`);

            // PrivateStoreCreated(owner indexed, store indexed, storeIndex indexed, gasStation)
            let deployedAddress: string | undefined;
            for (const log of receipt.logs) {
                if (log.address.toLowerCase() === factoryAddress.toLowerCase() && log.topics.length >= 3) {
                    deployedAddress = '0x' + log.topics[2]!.slice(26);
                    break;
                }
            }
            if (!deployedAddress) {
                const stores = await publicClient.readContract({
                    address: factoryAddress as Address,
                    abi: FACTORY_ABI,
                    functionName: 'getStoresByOwner',
                    args: [walletClient.account.address],
                });
                deployedAddress = stores[stores.length - 1] as string;
            }

            // Link it to this wallet. If that fails the store exists but is unused,
            // so say so and offer a retry instead of reporting success.
            setState({ step: 'registering', txHash, contractAddress: deployedAddress });
            try {
                await apiPost('/api/v1/deploy/register', { contractAddress: deployedAddress, contractType: 'privateStore' });
            } catch (err) {
                setState({ step: 'unlinked', txHash, contractAddress: deployedAddress, error: err instanceof Error ? err.message : 'Linking failed' });
                return deployedAddress;
            }

            setState({ step: 'done', txHash, contractAddress: deployedAddress });
            return deployedAddress;
        } catch (err) {
            setState({
                step: 'error',
                error: err instanceof Error ? err.message : 'Deployment failed',
            });
            return null;
        }
    }, [walletClient, publicClient, factoryAddress]);

    /**
     * Get gas station balance and estimated remaining operations.
     */
    const getGasStationInfo = useCallback(async (gasStationAddress: string): Promise<GasStationInfo | null> => {
        if (!publicClient) return null;
        try {
            const balance = await publicClient.getBalance({
                address: gasStationAddress as Address,
            });

            // Estimate: ~50,000 gas per PlugPort operation, ~50 gwei gas price on Monad
            const avgGasPerOp = 50_000n;
            const avgGasPrice = 50_000_000n; // 0.05 gwei (Monad is cheap)
            const costPerOp = avgGasPerOp * avgGasPrice;
            const estimatedOps = costPerOp > 0n ? Number(balance / costPerOp) : 0;

            const LOW_BALANCE_THRESHOLD = parseEther('0.1');

            return {
                address: gasStationAddress,
                balance: formatEther(balance),
                balanceWei: balance,
                estimatedOps,
                isLow: balance < LOW_BALANCE_THRESHOLD,
            };
        } catch {
            return null;
        }
    }, [publicClient]);

    /**
     * Query user's deployed stores from the factory.
     */
    const getDeployedStores = useCallback(async (ownerAddress: string): Promise<string[]> => {
        if (!publicClient || !factoryAddress) return [];
        try {
            const stores = await publicClient.readContract({
                address: factoryAddress as Address,
                abi: FACTORY_ABI,
                functionName: 'getStoresByOwner',
                args: [ownerAddress as Address],
            });
            return stores as string[];
        } catch {
            return [];
        }
    }, [publicClient, factoryAddress]);

    const reset = useCallback(() => {
        setState({ step: 'idle' });
    }, []);

    return {
        state,
        deployPrivateStore,
        estimateDeployCost,
        linkStore,
        getGasStationInfo,
        getDeployedStores,
        reset,
    };
}
