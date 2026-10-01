// Per-customer private stores (architecture decision 4, option B).
//
// A customer can deploy their own PlugPortPrivateStore through the factory and
// link it to their wallet; their private collections then live in a contract
// they own. Customers without one keep using the shared private store.
//
// A store is only accepted after checking it on-chain: deployed by our factory
// for this wallet, owned by this wallet, and naming PlugPort's writer as its gas
// station. Anything else — an arbitrary contract, someone else's store, or one
// the customer has already cut PlugPort off from — is refused. One store per
// wallet (decision B1).

import { ethers } from 'ethers';
import type { KVAdapter } from '@plugport/shared';

const FACTORY_ABI = ['function storeOwner(address store) view returns (address)'];
const WRITER_CHECK_TTL_MS = 60_000;
const STORE_ABI = [
    'function owner() view returns (address)',
    'function gasStation() view returns (address)',
];

export interface LinkedStore {
    address: string;
    linkedAt: number;
}

export type Verification = { ok: true } | { ok: false; reason: string };

export class PrivateStoreRegistry {
    private readonly factory: ethers.Contract;
    private readonly writer: string;
    private readonly cache = new Map<string, LinkedStore | null>();
    /** Recent answers to "does this store still accept PlugPort's writer?" */
    private readonly writerChecks = new Map<string, { result: Verification; expires: number }>();

    constructor(
        private readonly kv: KVAdapter,
        private readonly provider: ethers.Provider,
        factoryAddress: string,
        writerAddress: string,
    ) {
        this.factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
        this.writer = writerAddress.toLowerCase();
    }

    /** PlugPort's writer: the gas station a customer's store must name. */
    get writerAddress(): string {
        return ethers.getAddress(this.writer);
    }

    /** Check on-chain that `store` may hold `wallet`'s private data. */
    async verify(store: string, wallet: string): Promise<Verification> {
        if (!ethers.isAddress(store)) return { ok: false, reason: 'not a valid contract address' };
        const owner = wallet.toLowerCase();
        const deployedFor = String(await this.factory.storeOwner(store)).toLowerCase();
        if (deployedFor === ethers.ZeroAddress) return { ok: false, reason: 'this contract was not deployed by the PlugPort private store factory' };
        if (deployedFor !== owner) return { ok: false, reason: 'this store was deployed for a different wallet' };
        const contract = new ethers.Contract(store, STORE_ABI, this.provider);
        const [storeOwner, gasStation] = await Promise.all([contract.owner(), contract.gasStation()]);
        if (String(storeOwner).toLowerCase() !== owner) return { ok: false, reason: 'this store has been transferred to a different owner' };
        if (String(gasStation).toLowerCase() !== this.writer) {
            return { ok: false, reason: `this store does not authorise PlugPort's writer (${this.writerAddress}) — it may have been cut off` };
        }
        return { ok: true };
    }

    /**
     * Whether `store` still names PlugPort's writer as its gas station. A store
     * whose owner revoked it can be neither written nor read by PlugPort (its
     * read functions are restricted too). Cached for WRITER_CHECK_TTL_MS: one
     * RPC call per store per minute, and restored access is noticed within a
     * minute.
     */
    async checkWriter(store: string): Promise<Verification> {
        const key = store.toLowerCase();
        const cached = this.writerChecks.get(key);
        if (cached && Date.now() < cached.expires) return cached.result;
        const gasStation = String(await new ethers.Contract(store, STORE_ABI, this.provider).gasStation()).toLowerCase();
        const result: Verification = gasStation === this.writer
            ? { ok: true }
            : { ok: false, reason: `its owner has revoked PlugPort's writer (${this.writerAddress})` };
        this.writerChecks.set(key, { result, expires: Date.now() + WRITER_CHECK_TTL_MS });
        return result;
    }

    /** The store linked to `wallet`, or null. */
    async storeFor(wallet: string): Promise<LinkedStore | null> {
        const key = wallet.toLowerCase();
        if (this.cache.has(key)) return this.cache.get(key)!;
        const raw = await this.kv.get(this.metaKey(key));
        const linked = raw ? (JSON.parse(raw.toString()) as LinkedStore) : null;
        this.cache.set(key, linked);
        return linked;
    }

    /**
     * Verify `store` and link it to `wallet`. Re-linking the same store is a
     * no-op; linking a different one is refused until moving data between
     * stores is supported.
     */
    async link(wallet: string, store: string): Promise<Verification & { linked?: LinkedStore }> {
        const verification = await this.verify(store, wallet);
        if (!verification.ok) return verification;
        const address = ethers.getAddress(store);
        const existing = await this.storeFor(wallet);
        if (existing && existing.address.toLowerCase() !== address.toLowerCase()) {
            return { ok: false, reason: `this wallet already has a private store (${existing.address}); switching stores isn't supported yet` };
        }
        if (existing) return { ok: true, linked: existing };
        const linked: LinkedStore = { address, linkedAt: Date.now() };
        await this.kv.put(this.metaKey(wallet.toLowerCase()), Buffer.from(JSON.stringify(linked)));
        this.cache.set(wallet.toLowerCase(), linked);
        return { ok: true, linked };
    }

    /** Every wallet with a linked store (used to resume moves after a restart). */
    async linkedWallets(): Promise<string[]> {
        const entries = await this.kv.scan({ prefix: 'meta:privatestore:', limit: 100000 });
        return entries.map((e) => e.key.slice('meta:privatestore:'.length));
    }

    private metaKey(wallet: string): string {
        return `meta:privatestore:${wallet}`;
    }
}
