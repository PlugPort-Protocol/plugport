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

export type DeploymentStep = 'idle' | 'estimating' | 'deploying' | 'confirming' | 'registering' | 'done' | 'error';

export interface DeploymentState {
    step: DeploymentStep;
    txHash?: string;
    contractAddress?: string;
    error?: string;
    gasEstimate?: string;
}

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

    /**
     * Deploy a new PlugPortPrivateStore via the factory contract.
     * Uses PlugPort's system gas station automatically.
     */
    const deployPrivateStore = useCallback(async () => {
        if (!walletClient || !publicClient || !factoryAddress) {
            setState({ step: 'error', error: 'Wallet not connected or factory address not configured' });
            return null;
        }

        try {

            // Step 1: Fetch system gas station
            setState({ step: 'estimating' });
            let gasStationAddress: string;
            try {
                const res = await apiGet<{ address: string }>('/api/v1/deploy/system-gas-station');
                if (!res.address) throw new Error('No gas station provided by backend');
                gasStationAddress = res.address;
            } catch (err) {
                setState({ step: 'error', error: 'Failed to fetch PlugPort system gas station' });
                return null;
            }

            // Step 2: Estimate gas
            let gasEstimate: bigint;
            try {
                gasEstimate = await publicClient.estimateContractGas({
                    address: factoryAddress as Address,
                    abi: FACTORY_ABI,
                    functionName: 'createPrivateStore',
                    args: [gasStationAddress as Address],
                    account: walletClient.account,
                });
            } catch {
                // Fallback gas estimate if estimation fails
                gasEstimate = 500_000n;
            }

            setState({
                step: 'estimating',
                gasEstimate: formatEther(gasEstimate * 50_000_000n), // rough cost at ~50 gwei
            });

            // Step 3: Send deploy transaction
            setState(prev => ({ ...prev, step: 'deploying' }));
            const txHash = await walletClient.writeContract({
                address: factoryAddress as Address,
                abi: FACTORY_ABI,
                functionName: 'createPrivateStore',
                args: [gasStationAddress as Address],
                gas: gasEstimate + (gasEstimate / 5n), // 20% buffer
            });

            setState(prev => ({ ...prev, step: 'confirming', txHash }));

            // Step 4: Wait for confirmation
            const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

            // Extract deployed contract address from logs
            // The PrivateStoreCreated event: topic0 = keccak256("PrivateStoreCreated(address,address,uint256)")
            // The store address is in the second indexed topic
            let deployedAddress: string | undefined;
            for (const log of receipt.logs) {
                if (log.address.toLowerCase() === factoryAddress.toLowerCase() && log.topics.length >= 3) {
                    // Second indexed param is the store address
                    deployedAddress = '0x' + log.topics[2]!.slice(26);
                    break;
                }
            }

            if (!deployedAddress) {
                // Fallback: query the factory for the latest store
                const stores = await publicClient.readContract({
                    address: factoryAddress as Address,
                    abi: FACTORY_ABI,
                    functionName: 'getStoresByOwner',
                    args: [walletClient.account.address],
                });
                deployedAddress = stores[stores.length - 1] as string;
            }

            // Step 4: Register with the server
            setState(prev => ({ ...prev, step: 'registering', contractAddress: deployedAddress }));
            try {
                await apiPost('/api/v1/deploy/register', {
                    contractAddress: deployedAddress,
                    contractType: 'privateStore',
                    ownerAddress: walletClient.account.address,
                });
            } catch {
                // Non-fatal: contract is deployed even if server registration fails
                console.warn('Server registration failed, contract is still deployed');
            }

            setState({
                step: 'done',
                txHash,
                contractAddress: deployedAddress,
            });

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
        getGasStationInfo,
        getDeployedStores,
        reset,
    };
}
