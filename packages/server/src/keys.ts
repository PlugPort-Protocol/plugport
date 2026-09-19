// Wallet-role and secret resolution.
//
// Historically one key (MONAD_PRIVATE_KEY) played every part: it signed every
// write to every contract, it was the owner/admin of the contracts that have
// one, it was the root of the AES key that encrypts private collections, and
// it seeded the session-cookie secret. Compromising the server therefore meant
// compromising all of that at once.
//
// Each role now has its own variable, and each falls back to the old one so an
// existing single-key deployment (or local dev) behaves exactly as before:
//
//   STORE_PRIVATE_KEY          signs writes to PlugPortStore
//   PRIVATE_STORE_PRIVATE_KEY  signs writes to PlugPortPrivateStore
//   MESSAGEBROKER_PRIVATE_KEY  signs publishes to PlugPortMessageBroker
//   AUTH_GAS_STATION_PRIVATE_KEYS  (already separate) relays PlugPortAuth meta-txs
//   ENCRYPTION_KEY             root secret for the private-collection AES key —
//                              NOT a wallet; it needs no on-chain authority
//   SESSION_SECRET             seed for the session-cookie secret (see auth/session.ts)
//
// Contract owner/admin keys are deliberately absent: nothing on the server
// should ever hold them.

import { ethers } from 'ethers';

type Env = Record<string, string | undefined>;

export interface ResolvedKeys {
    store?: string;
    privateStore?: string;
    broker?: string;
    /** Root secret for AES key derivation (see storage/encryption-layer.ts). */
    encryption?: string;
}

const clean = (v: string | undefined): string | undefined => {
    const t = v?.trim();
    return t ? t : undefined;
};

export function resolveKeys(env: Env): ResolvedKeys {
    const legacy = clean(env.MONAD_PRIVATE_KEY);
    const store = clean(env.STORE_PRIVATE_KEY) ?? legacy;
    return {
        store,
        privateStore: clean(env.PRIVATE_STORE_PRIVATE_KEY) ?? store,
        broker: clean(env.MESSAGEBROKER_PRIVATE_KEY) ?? store,
        // Legacy first: deployments that already have encrypted data derived
        // their AES key from MONAD_PRIVATE_KEY, and must keep doing so.
        encryption: clean(env.ENCRYPTION_KEY) ?? legacy ?? store,
    };
}

const normalizeKey = (k: string) => k.replace(/^0x/i, '').toLowerCase();

function addressOf(key: string): string {
    return new ethers.Wallet(key.startsWith('0x') ? key : `0x${key}`).address;
}

export interface RoleReport {
    /** role name -> wallet address (one entry per configured signing role) */
    roles: { role: string; address: string }[];
    /** wallets that play more than one role: address -> roles */
    shared: { address: string; roles: string[] }[];
    /** true when the AES root secret is not the private key of any signing wallet */
    encryptionSeparate: boolean;
}

export function describeRoles(keys: ResolvedKeys, authKeysCsv?: string): RoleReport {
    const signing: { role: string; key: string }[] = [];
    if (keys.store) signing.push({ role: 'store', key: keys.store });
    if (keys.privateStore) signing.push({ role: 'privateStore', key: keys.privateStore });
    if (keys.broker) signing.push({ role: 'broker', key: keys.broker });
    for (const k of (authKeysCsv ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
        signing.push({ role: 'auth', key: k });
    }

    const roles = signing.map(({ role, key }) => ({ role, address: addressOf(key) }));

    const byAddress = new Map<string, string[]>();
    for (const { role, address } of roles) {
        const list = byAddress.get(address) ?? [];
        if (!list.includes(role)) list.push(role);
        byAddress.set(address, list);
    }
    const shared = [...byAddress.entries()]
        .filter(([, r]) => r.length > 1)
        .map(([address, r]) => ({ address, roles: r }));

    const signingKeys = new Set(signing.map((s) => normalizeKey(s.key)));
    const encryptionSeparate = !keys.encryption || !signingKeys.has(normalizeKey(keys.encryption));

    return { roles, shared, encryptionSeparate };
}

/** Startup report: which wallet plays which role, and whether any are shared. */
export function logWalletRoles(keys: ResolvedKeys, authKeysCsv?: string): void {
    let report: RoleReport;
    try {
        report = describeRoles(keys, authKeysCsv);
    } catch (err) {
        console.warn('  [Keys] Could not derive wallet addresses:', err instanceof Error ? err.message : 'unknown error');
        return;
    }
    if (report.roles.length === 0) return;

    for (const { role, address } of report.roles) {
        console.log(`  [Keys] ${role.padEnd(12)} ${address}`);
    }
    for (const { address, roles } of report.shared) {
        console.warn(`  [Keys] WARNING: ${roles.join(' + ')} share ${address} — one compromised key affects all of them`);
    }
    if (!report.encryptionSeparate) {
        console.warn('  [Keys] WARNING: the encryption root is a signing wallet key — set ENCRYPTION_KEY to decouple them');
    }
}
