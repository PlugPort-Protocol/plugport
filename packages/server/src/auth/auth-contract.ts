// PlugPort Auth Contract Adapter
// Server-side ethers.js integration with the PlugPortAuth.sol smart contract.
//
// Architecture:
//   - Reads (getActiveKeys, getVerifier, validateKey) are free eth_call invocations
//   - Writes (registerKeyMeta, revokeKeyMeta) are transactions sent by the gas station wallet
//   - Initializes lazily — if AUTH_CONTRACT_ADDRESS is not set, methods return graceful fallbacks
//
// Configuration (env vars):
//   - MONAD_RPC_URL              — Monad RPC endpoint (reused from storage adapter)
//   - AUTH_CONTRACT_ADDRESS      — Deployed PlugPortAuth contract address
//   - AUTH_GAS_STATION_PRIVATE_KEYS — Comma-separated list of 64-char hex private keys for gas station wallets

import { ethers } from 'ethers';

// ---- ABI (minimal interface for server-side interactions) ----

const PLUGPORT_AUTH_ABI = [
    // Meta-transaction writes (gas station sends these)
    'function registerKeyMeta(address keyOwner, bytes32 commitment, bytes32 salt, bytes32 storedKey, bytes32 serverKey, uint256 nonce, bytes signature) external',
    'function revokeKeyMeta(address keyOwner, uint8 keyIndex, uint256 nonce, bytes signature) external',
    'function rotateKeyMeta(address keyOwner, uint8 oldKeyIndex, bytes32 newCommitment, bytes32 newSalt, bytes32 newStoredKey, bytes32 newServerKey, uint256 nonce, bytes signature) external',

    // View functions (free reads)
    'function getActiveKeys(address addr) external view returns (uint8[])',
    'function getVerifier(address addr, uint8 keyIndex) external view returns (bytes32 salt, bytes32 storedKey, bytes32 serverKey, bool active)',
    'function getCommitment(address addr, uint8 keyIndex) external view returns (bytes32)',
    'function validateKey(address addr, bytes32 keyHash) external view returns (bool)',
    'function isKeyActive(address addr, uint8 keyIndex) external view returns (bool)',
    'function getKeyCount(address addr) external view returns (uint8)',
    'function nonces(address) external view returns (uint256)',

    // Events
    'event KeyRegistered(address indexed keyOwner, uint8 keyIndex, uint256 timestamp)',
    'event KeyRevoked(address indexed keyOwner, uint8 keyIndex, uint256 timestamp)',
];

// ---- Types ----

export interface OnChainKeyEntry {
    keyIndex: number;
    commitment: string;
    salt: string;
    storedKey: string;
    serverKey: string;
    active: boolean;
    createdAt: number;
}

export interface ScramVerifier {
    salt: string;
    storedKey: string;
    serverKey: string;
    active: boolean;
}

// ---- Adapter ----

export class AuthContractAdapter {
    private provider: ethers.JsonRpcProvider;
    private gasStationWallets: ethers.Wallet[] = [];
    private writeContracts: ethers.Contract[] = [];
    private walletBalances: Map<string, bigint> = new Map();
    private currentWalletIndex = 0;
    
    private readContract: ethers.Contract | null = null;
    private contractAddress: string;

    constructor() {
        const rpcUrl = process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz';
        this.contractAddress = process.env.AUTH_CONTRACT_ADDRESS || '';
        
        // Support comma-separated keys or fallback to the old env var
        const keysEnv = process.env.AUTH_GAS_STATION_PRIVATE_KEYS || process.env.AUTH_GAS_STATION_PRIVATE_KEY || '';
        const keys = keysEnv.split(',').map(k => k.trim()).filter(k => k.length > 0);

        this.provider = new ethers.JsonRpcProvider(rpcUrl);

        if (this.contractAddress) {
            this.readContract = new ethers.Contract(this.contractAddress, PLUGPORT_AUTH_ABI, this.provider);

            if (keys.length > 0) {
                for (const key of keys) {
                    try {
                        const wallet = new ethers.Wallet(key, this.provider);
                        this.gasStationWallets.push(wallet);
                        this.writeContracts.push(new ethers.Contract(this.contractAddress, PLUGPORT_AUTH_ABI, wallet));
                        console.log(`[AuthContract] Loaded gas station wallet: ${wallet.address}`);
                    } catch (err) {
                        console.warn(`[AuthContract] Failed to load a wallet key: ${err}`);
                    }
                }
                
                // Start background balance poller
                this.pollBalances();
                setInterval(() => this.pollBalances(), 60000); // every 60s
            }
        }
        console.log(`[AuthContract] Initialized with contract: ${this.contractAddress || '(not configured)'}`);
    }

    private async pollBalances() {
        for (const wallet of this.gasStationWallets) {
            try {
                const bal = await this.provider.getBalance(wallet.address);
                this.walletBalances.set(wallet.address, bal);
            } catch (err) {
                // Ignore transient RPC errors during polling
            }
        }
    }

    /** 
     * Get the next well-funded gas station wallet contract using round-robin.
     */
    private getNextWriteContract(): ethers.Contract {
        if (this.writeContracts.length === 0) {
            throw new Error('Auth contract not configured (missing AUTH_CONTRACT_ADDRESS or AUTH_GAS_STATION_PRIVATE_KEYS)');
        }

        // Find wallets with > 0.05 MON (50,000,000,000,000,000 wei)
        const MIN_BALANCE = 50000000000000000n; // 0.05 ether
        const validIndices: number[] = [];

        for (let i = 0; i < this.gasStationWallets.length; i++) {
            const addr = this.gasStationWallets[i].address;
            const bal = this.walletBalances.get(addr);
            // If balance is unknown (not polled yet), assume it's valid for now to avoid blocking startup
            if (bal === undefined || bal > MIN_BALANCE) {
                validIndices.push(i);
            }
        }

        if (validIndices.length === 0) {
            throw new Error('All gas stations are depleted (balance < 0.05 MON). Cannot process meta-transactions.');
        }

        // Round robin among valid indices
        const selectedIndex = validIndices[this.currentWalletIndex % validIndices.length];
        this.currentWalletIndex = (this.currentWalletIndex + 1) % validIndices.length;
        
        return this.writeContracts[selectedIndex];
    }

    /** Returns one of the active PlugPort system gas station addresses */
    public getSystemGasStationAddress(): string | null {
        if (this.gasStationWallets.length === 0) return null;
        const validIndices: number[] = [];
        const MIN_BALANCE = 50000000000000000n;
        for (let i = 0; i < this.gasStationWallets.length; i++) {
            const bal = this.walletBalances.get(this.gasStationWallets[i].address);
            if (bal === undefined || bal > MIN_BALANCE) validIndices.push(i);
        }
        if (validIndices.length === 0) return null;
        
        // Just return the next one in round-robin sequence to distribute load
        const selectedIndex = validIndices[this.currentWalletIndex % validIndices.length];
        return this.gasStationWallets[selectedIndex].address;
    }

    /** Whether the adapter is fully configured for on-chain operations */
    get isConfigured(): boolean {
        return !!this.contractAddress && this.writeContracts.length > 0;
    }

    /** Whether read-only operations are available */
    get isReadable(): boolean {
        return !!this.contractAddress && !!this.readContract;
    }

    // ---- Write Operations (gas station sends tx) ----

    /**
     * Register a key on behalf of a user via meta-transaction.
     * The gas station wallet sends the transaction; the user never needs MON.
     */
    async registerKeyMeta(
        keyOwner: string,
        commitment: string,
        salt: string,
        storedKey: string,
        serverKey: string,
        nonce: number,
        signature: string,
    ): Promise<{ txHash: string; keyIndex: number }> {
        const contract = this.getNextWriteContract();

        console.log(`[AuthContract] registerKeyMeta for ${keyOwner} (nonce: ${nonce})`);

        const tx = await contract.registerKeyMeta(
            keyOwner,
            commitment,
            salt,
            storedKey,
            serverKey,
            nonce,
            signature,
        );

        const receipt = await tx.wait();
        console.log(`[AuthContract] Key registered — tx: ${receipt.hash}`);

        // Parse the KeyRegistered event to get the assigned key index
        let keyIndex = -1;
        for (const log of receipt.logs) {
            try {
                const parsed = this.readContract!.interface.parseLog({
                    topics: log.topics as string[],
                    data: log.data,
                });
                if (parsed?.name === 'KeyRegistered') {
                    keyIndex = Number(parsed.args.keyIndex);
                }
            } catch {
                // Skip logs from other contracts
            }
        }

        return { txHash: receipt.hash, keyIndex };
    }

    /**
     * Revoke a key on behalf of a user via meta-transaction.
     */
    async revokeKeyMeta(
        keyOwner: string,
        keyIndex: number,
        nonce: number,
        signature: string,
    ): Promise<{ txHash: string }> {
        const contract = this.getNextWriteContract();

        console.log(`[AuthContract] revokeKeyMeta for ${keyOwner} (index: ${keyIndex}, nonce: ${nonce})`);

        const tx = await contract.revokeKeyMeta(
            keyOwner,
            keyIndex,
            nonce,
            signature,
        );
        const receipt = await tx.wait();
        console.log(`[AuthContract] Key revoked — tx: ${receipt.hash}`);

        return { txHash: receipt.hash };
    }

    /**
     * Atomically rotate a key on behalf of a user via meta-transaction.
     * Revokes the old key and registers a new one in a single transaction.
     */
    async rotateKeyMeta(
        keyOwner: string,
        oldKeyIndex: number,
        newCommitment: string,
        newSalt: string,
        newStoredKey: string,
        newServerKey: string,
        nonce: number,
        signature: string,
    ): Promise<{ txHash: string; newKeyIndex: number }> {
        const contract = this.getNextWriteContract();

        console.log(`[AuthContract] rotateKeyMeta for ${keyOwner} (oldIndex: ${oldKeyIndex}, nonce: ${nonce})`);

        const tx = await contract.rotateKeyMeta(
            keyOwner,
            oldKeyIndex,
            newCommitment,
            newSalt,
            newStoredKey,
            newServerKey,
            nonce,
            signature,
        );
        const receipt = await tx.wait();
        console.log(`[AuthContract] Key rotated — tx: ${receipt.hash}`);

        // Parse KeyRotated event to get the new key index
        let newKeyIndex = -1;
        for (const log of receipt.logs) {
            try {
                const parsed = this.readContract!.interface.parseLog({
                    topics: log.topics as string[],
                    data: log.data,
                });
                if (parsed?.name === 'KeyRotated') {
                    newKeyIndex = Number(parsed.args.newKeyIndex);
                }
            } catch {
                // Skip logs from other contracts
            }
        }

        return { txHash: receipt.hash, newKeyIndex };
    }

    // ---- Read Operations (free RPC reads) ----

    /**
     * Get all active key indices for an address.
     */
    async getActiveKeys(address: string): Promise<OnChainKeyEntry[]> {
        if (!this.isReadable) return [];

        try {
            const activeIndices: number[] = (await this.readContract!.getActiveKeys(address))
                .map((n: bigint) => Number(n));

            // I4: Batch RPC calls with Promise.all instead of sequential fetches
            const entries = await Promise.all(
                activeIndices.map(async (idx) => {
                    const [commitment, verifier] = await Promise.all([
                        this.readContract!.getCommitment(address, idx),
                        this.readContract!.getVerifier(address, idx),
                    ]);
                    return {
                        keyIndex: idx,
                        commitment,
                        salt: verifier.salt,
                        storedKey: verifier.storedKey,
                        serverKey: verifier.serverKey,
                        active: verifier.active,
                        createdAt: 0,
                    } satisfies OnChainKeyEntry;
                }),
            );

            return entries;
        } catch (err) {
            console.error(`[AuthContract] getActiveKeys failed for ${address}:`, err);
            return [];
        }
    }

    /**
     * Get SCRAM verifier for a specific key (used during SCRAM handshake).
     */
    async getVerifier(address: string, keyIndex: number): Promise<ScramVerifier | null> {
        if (!this.isReadable) return null;

        try {
            const result = await this.readContract!.getVerifier(address, keyIndex);
            return {
                salt: result.salt,
                storedKey: result.storedKey,
                serverKey: result.serverKey,
                active: result.active,
            };
        } catch (err) {
            console.error(`[AuthContract] getVerifier failed for ${address}[${keyIndex}]:`, err);
            return null;
        }
    }

    /**
     * Validate an API key hash against all active commitments.
     * Used by HTTP auth middleware (x-api-key header validation).
     */
    async validateKey(address: string, keyHash: string): Promise<boolean> {
        if (!this.isReadable) return false;

        try {
            return await this.readContract!.validateKey(address, keyHash);
        } catch (err) {
            console.error(`[AuthContract] validateKey failed:`, err);
            return false;
        }
    }

    /**
     * Check if a specific key is active.
     */
    async isKeyActive(address: string, keyIndex: number): Promise<boolean> {
        if (!this.isReadable) return false;

        try {
            return await this.readContract!.isKeyActive(address, keyIndex);
        } catch (err) {
            return false;
        }
    }

    /**
     * Get the current nonce for meta-transaction replay protection.
     */
    async getNonce(address: string): Promise<number> {
        if (!this.isReadable) return 0;

        try {
            return Number(await this.readContract!.nonces(address));
        } catch (err) {
            return 0;
        }
    }

    /**
     * Get total key count for an address (including revoked).
     */
    async getKeyCount(address: string): Promise<number> {
        if (!this.isReadable) return 0;

        try {
            return Number(await this.readContract!.getKeyCount(address));
        } catch (err) {
            return 0;
        }
    }


}

// ---- Singleton ----

let _instance: AuthContractAdapter | null = null;

/**
 * Get or create the singleton AuthContractAdapter.
 * Safe to call even if env vars are not set — methods will return graceful fallbacks.
 */
export function getAuthContract(): AuthContractAdapter {
    if (!_instance) {
        _instance = new AuthContractAdapter();
    }
    return _instance;
}
