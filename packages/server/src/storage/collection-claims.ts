// Who owns a new collection, and where its data goes (P8: private by default).
//
// The first write by a wallet to a collection nobody owns claims it. New
// collections are private unless the creator asks for public: anything written
// while public stays readable in the chain's history forever, so the safe
// default is the one that never leaks by accident. A private collection lives
// in the owner's own store when they have an active one (option B), otherwise
// in the shared private store.
//
// The claim must happen *before* the first write: reads route by the privacy
// record, so data written to the public store first and claimed as private
// afterwards would no longer be found.

import type { PrivacyManager } from './privacy-manager.js';
import type { PrivateStoreRegistry } from './private-store-registry.js';

export type CollectionMode = 'public' | 'private';

/** The mode of a new collection when its creator doesn't choose one. */
export const DEFAULT_COLLECTION_MODE: CollectionMode = 'private';

export class CollectionClaims {
    constructor(
        private readonly privacy: PrivacyManager,
        private readonly stores?: PrivateStoreRegistry,
    ) {}

    /**
     * Claim `collection` for `owner` if nobody owns it yet. Returns true when
     * this call created the record. Throws if the owner's store can't be
     * checked, rather than guessing where private data should go.
     */
    async claim(collection: string, owner: string, mode: CollectionMode = DEFAULT_COLLECTION_MODE): Promise<boolean> {
        if (await this.privacy.getCollectionPrivacy(collection)) return false;
        const storeAddress = mode === 'private' ? await this.activeStoreOf(owner) : undefined;
        return this.privacy.claimIfUnowned(collection, owner, { mode, storeAddress });
    }

    /** The owner's own store if it is linked and still accepts PlugPort's writer. */
    private async activeStoreOf(owner: string): Promise<string | undefined> {
        if (!this.stores) return undefined;
        const linked = await this.stores.storeFor(owner);
        if (!linked) return undefined;
        return (await this.stores.verify(linked.address, owner)).ok ? linked.address : undefined;
    }
}
