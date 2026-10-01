// Per-wallet namespaces: each customer (wallet) has its own collection space,
// so two customers can both have `users` and never see or touch each other's.
//
// Physically, a wallet's collection is named "<wallet>.<name>" (lowercase
// address). Clients use plain names for their own collections and the server
// resolves them by who is logged in. Another wallet's collection — readable
// when public or shared with you — is addressed by its qualified name:
// `0xOwner.users` over HTTP and SQL (`"0xOwner".users` in PostgreSQL), or with
// the owner's address as the database in MongoDB (`db.getSiblingDB('0xOwner')`).
//
// The operator (master key, no wallet) works in the shared namespace, where a
// plain name is the physical name: the unowned demo data. Wallets can read a
// shared collection under its plain name when they have none by that name,
// but not change it.
//
// Collections created before namespaces still carry their plain name, with an
// owner ("legacy"). They resolve exactly as if already in the owner's
// namespace, and NamespaceMigration moves them there in the background.

import type { Caller } from './collection-access.js';

const WALLET = /^0x[0-9a-f]{40}$/i;
const QUALIFIED = /^(0x[0-9a-fA-F]{40})\.(.+)$/;

export function isWalletAddress(value: string): boolean {
    return WALLET.test(value);
}

/** The wallet whose namespace a physical collection is in; undefined for the shared namespace. */
export function namespaceOwner(physical: string): string | undefined {
    const m = QUALIFIED.exec(physical);
    return m ? m[1].toLowerCase() : undefined;
}

export function qualify(owner: string, name: string): string {
    return `${owner.toLowerCase()}.${name}`;
}

interface NamespaceStore {
    getCollection(name: string): Promise<unknown>;
}

interface NamespacePrivacy {
    getCollectionPrivacy(name: string): Promise<unknown>;
    listRecords(): Promise<{ collection: string; record: { ownerAddress?: string; movedTo?: string } }[]>;
}

export class Namespaces {
    /** Legacy collections, still under their plain name: name → owner. */
    private readonly legacy = new Map<string, string>();
    /** Legacy collections already copied into their namespace, whose old copy is being removed. */
    private readonly retired = new Set<string>();

    constructor(
        private readonly store: NamespaceStore,
        private readonly privacy: NamespacePrivacy,
    ) {}

    /** Find the legacy collections. Call once at startup, before serving requests. */
    async load(): Promise<void> {
        this.legacy.clear();
        this.retired.clear();
        for (const { collection, record } of await this.privacy.listRecords()) {
            if (namespaceOwner(collection) || !record.ownerAddress) continue;
            if (record.movedTo) this.retired.add(collection);
            else this.legacy.set(collection, record.ownerAddress.toLowerCase());
        }
    }

    /** Legacy collections still to move: [name, owner]. */
    legacyCollections(): [string, string][] {
        return [...this.legacy];
    }

    /** The legacy collection now lives at its qualified name; stop resolving to the old one. */
    retire(name: string): void {
        this.legacy.delete(name);
        this.retired.add(name);
    }

    /** Its old copy is gone. */
    forget(name: string): void {
        this.retired.delete(name);
    }

    /**
     * The physical collection a client's name refers to.
     * @param intent a read may fall back to shared data under a plain name; a write never does.
     */
    async resolve(name: string, caller: Caller, intent: 'read' | 'write'): Promise<string> {
        const m = QUALIFIED.exec(name);
        const owner = m ? m[1].toLowerCase() : caller.wallet?.toLowerCase();
        if (!owner) return name; // the operator, in the shared namespace
        const local = m ? m[2] : name;
        if (this.legacy.get(local) === owner) return local;
        const physical = qualify(owner, local);
        if (!m && intent === 'read' && !this.legacy.has(local) && !this.retired.has(local)
            && await this.store.getCollection(local)
            && !(await this.store.getCollection(physical))
            && !(await this.privacy.getCollectionPrivacy(local))) {
            return local; // shared data, and the caller has no collection of that name
        }
        return physical;
    }

    /** MongoDB: a wallet address as the database is that wallet's namespace. */
    resolveInDb(db: string, name: string, caller: Caller, intent: 'read' | 'write'): Promise<string> {
        return this.resolve(isWalletAddress(db) && !QUALIFIED.test(name) ? qualify(db, name) : name, caller, intent);
    }

    /** How a physical collection is named to `caller`: plain for its own, qualified for another wallet's. */
    display(physical: string, caller: Caller): string {
        const wallet = caller.wallet?.toLowerCase();
        const m = QUALIFIED.exec(physical);
        if (m) return m[1].toLowerCase() === wallet ? m[2] : physical;
        const legacyOwner = this.legacy.get(physical);
        if (legacyOwner && legacyOwner !== wallet) return qualify(legacyOwner, physical);
        return physical;
    }

    /**
     * The collections to list for `caller`, with the names it uses for them.
     * A shared collection hidden by the caller's own one of the same name is
     * left out (the plain name reaches the caller's). With `inNamespace`, only
     * that wallet's collections, by their plain names (MongoDB's database view).
     */
    view(physicalNames: string[], caller: Caller, inNamespace?: string): { physical: string; name: string }[] {
        const ns = inNamespace?.toLowerCase();
        const ownerOf = (physical: string) => namespaceOwner(physical) ?? this.legacy.get(physical);
        const entries: { physical: string; name: string }[] = [];
        for (const physical of physicalNames) {
            if (this.retired.has(physical)) continue;
            if (ns === undefined) {
                entries.push({ physical, name: this.display(physical, caller) });
            } else if (ownerOf(physical) === ns) {
                entries.push({ physical, name: namespaceOwner(physical) ? physical.substring(ns.length + 1) : physical });
            }
        }
        const ownedNames = new Set(entries.filter((e) => ownerOf(e.physical)).map((e) => e.name));
        return entries.filter((e) => ownerOf(e.physical) || !ownedNames.has(e.name));
    }
}
