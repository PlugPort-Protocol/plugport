// Who may read and write a collection — one rule for every protocol.
//
// It used to live in the HTTP server alone, so the MongoDB wire protocol
// enforced nothing: any wallet with an API key could read private collections
// and write to anyone's collection through mongosh, whatever the dashboard and
// HTTP API allowed.
//
//   Reads:  public collections — anyone; private ones — the owner and wallets
//           granted read access.
//   Writes: the owner and wallets granted write access. A wallet writing to a
//           collection that doesn't exist yet claims it first (CollectionClaims:
//           private by default). An existing collection nobody owns is
//           read-only for wallets.
//   The operator (the server's master API_KEY, or dev mode with no key) carries
//   no wallet and may write to any non-private collection.

import type { DocumentStore } from './document-store.js';
import type { CollectionMetadata } from '@plugport/shared';
import type { PrivacyManager } from './privacy-manager.js';
import type { CollectionClaims, CollectionMode } from './collection-claims.js';
import type { TranslatedQuery, JoinPlan } from '../protocols/sql-translator.js';
import { namespaceOwner, type Namespaces } from './namespaces.js';

/** The collections a translated SQL statement reads or writes, for the SQL wire servers. */
export function sqlAccessTargets(query: TranslatedQuery): [string, 'read' | 'write'][] {
    switch (query.type) {
        case 'find': case 'aggregate': case 'count': case 'describe':
            return query.collection ? [[query.collection, 'read']] : [];
        case 'insert': case 'update': case 'delete':
        case 'createIndex': case 'dropIndex': case 'createCollection': case 'dropCollection':
            return query.collection ? [[query.collection, 'write']] : [];
        case 'join': {
            const plan = query.joinPlan;
            if (!plan) return [];
            return [plan.leftCollection, plan.rightCollection, ...(plan.additionalJoins ?? []).map((j) => j.rightCollection)]
                .map((c): [string, 'read'] => [c, 'read']);
        }
        default:
            return [];
    }
}

/** Replace every collection a translated statement names with its physical collection (per-wallet namespaces). */
export async function resolveQueryCollections(query: TranslatedQuery, namespaces: Namespaces, caller: Caller): Promise<void> {
    const intent = sqlAccessTargets(query)[0]?.[1] ?? 'read';
    if (query.collection) query.collection = await namespaces.resolve(query.collection, caller, intent);
    const resolvePlan = async (plan: JoinPlan) => {
        plan.leftCollection = await namespaces.resolve(plan.leftCollection, caller, 'read');
        plan.rightCollection = await namespaces.resolve(plan.rightCollection, caller, 'read');
        for (const extra of plan.additionalJoins ?? []) await resolvePlan(extra);
    };
    if (query.joinPlan) await resolvePlan(query.joinPlan);
}

export interface Caller {
    /** The verified wallet behind the request, if any. */
    wallet?: string;
    /** The server's own master key (or dev mode): admin access to non-private collections. */
    operator: boolean;
}

export type AccessResult = { ok: true } | { ok: false; errmsg: string };

export class CollectionAccess {
    constructor(
        private readonly privacy: PrivacyManager,
        private readonly store: DocumentStore,
        private readonly claims: CollectionClaims,
    ) {}

    /**
     * @param mode for a write that creates the collection: its visibility
     *   (default private). Ignored for existing collections.
     */
    async check(collection: string, caller: Caller, type: 'read' | 'write', mode?: CollectionMode): Promise<AccessResult> {
        const wallet = caller.wallet?.toLowerCase() || '';

        if (type === 'read') {
            if (await this.privacy.hasReadAccess(collection, wallet)) return { ok: true };
            return { ok: false, errmsg: `Access denied: collection ${collection} is private` };
        }

        let record = await this.privacy.getCollectionPrivacy(collection);
        // New collections go in the creator's namespace: a wallet's own, or the
        // shared one for the operator (see namespaces.ts).
        const ns = namespaceOwner(collection);
        const isNew = !record && !(await this.store.getCollection(collection));
        if (isNew && (caller.operator || wallet) && ns !== (caller.operator ? undefined : wallet)) {
            return {
                ok: false,
                errmsg: ns
                    ? `Access denied: ${collection} would be in the namespace of ${ns}; only that wallet can create collections there`
                    : `Access denied: ${collection} is in the shared namespace; wallets create collections in their own`,
            };
        }
        if (caller.operator) {
            if (record?.mode !== 'private') return { ok: true };
        } else if (wallet) {
            if (isNew) {
                await this.claims.claim(collection, wallet, mode);
                record = await this.privacy.getCollectionPrivacy(collection);
            }
            if (await this.privacy.hasWriteAccess(collection, wallet)) return { ok: true };
        }

        return {
            ok: false,
            errmsg: !record
                ? `Access denied: collection ${collection} has no owner and is read-only`
                : `Access denied: collection ${collection} belongs to another wallet (only its owner and wallets it grants write access can write)`,
        };
    }
}

/**
 * For the SQL wire servers: resolve a statement's collections (when
 * namespaces are on), then apply the access rule to each. Throws with the
 * reason when refused.
 */
export async function authorizeSqlQuery(query: TranslatedQuery, caller: Caller, access?: CollectionAccess, namespaces?: Namespaces): Promise<void> {
    if (namespaces) await resolveQueryCollections(query, namespaces, caller);
    if (!access) return;
    for (const [collection, type] of sqlAccessTargets(query)) {
        const result = await access.check(collection, caller, type);
        if (!result.ok) throw new Error(result.errmsg);
    }
}

/**
 * The collections a connection may read, by the names it uses for them: a
 * private collection's name is private too.
 */
export async function readableCollections(store: Pick<DocumentStore, 'listCollections'>, caller: Caller, access?: CollectionAccess, namespaces?: Namespaces): Promise<{ name: string; metadata: CollectionMetadata }[]> {
    let collections = await store.listCollections();
    if (access) {
        const readable = await Promise.all(collections.map((c) => access.check(c.name, caller, 'read')));
        collections = collections.filter((_, i) => readable[i].ok);
    }
    if (!namespaces) return collections.map((metadata) => ({ name: metadata.name, metadata }));
    const byName = new Map(collections.map((c) => [c.name, c]));
    return namespaces.view(collections.map((c) => c.name), caller).map((e) => ({ name: e.name, metadata: byName.get(e.physical)! }));
}
