// Recovering wallet-derived API keys.
//
// A key is derived from a wallet signature over "API Key #N", and only its hash
// (the commitment) is stored on-chain. Recovery therefore has to work the other
// way round from what it once did: start from the keys the chain actually holds,
// re-derive candidates, and attach a candidate only when its hash matches a
// registered commitment. The old code marked every derived candidate as an active
// key without checking, so a wallet with 3 keys was shown 10 — the 7 phantoms
// could not be revoked or rotated because no such slot exists on-chain.

export interface ChainKey {
    keyIndex: number;
    commitment: string;
    active: boolean;
    createdAt: number;
}

export interface RecoveredKey extends ChainKey {
    /** Set only when a derived key hashed to this key's commitment. */
    derivedKey?: string;
}

export interface RecoveryResult {
    keys: RecoveredKey[];
    recovered: number;
    total: number;
    /** True if the user cancelled a signature before every key was matched. */
    interrupted: boolean;
}

export async function recoverKeys(opts: {
    chainKeys: ChainKey[];
    /** Signs the derivation message for index `i` and returns the derived API key. */
    derive: (i: number) => Promise<string>;
    commitmentOf: (apiKey: string) => string;
    maxScan: number;
}): Promise<RecoveryResult> {
    const { chainKeys, derive, commitmentOf, maxScan } = opts;
    const derived = new Map<string, string>(); // commitment -> derived key
    const wanted = new Set(chainKeys.map(k => k.commitment.toLowerCase()));
    let interrupted = false;

    for (let i = 0; i < maxScan && derived.size < wanted.size; i++) {
        let apiKey: string;
        try {
            apiKey = await derive(i);
        } catch {
            // Wallet signature rejected/failed — stop, keep what we matched.
            interrupted = true;
            break;
        }
        const commitment = commitmentOf(apiKey).toLowerCase();
        if (wanted.has(commitment)) derived.set(commitment, apiKey);
    }

    const keys: RecoveredKey[] = chainKeys.map(k => {
        const derivedKey = derived.get(k.commitment.toLowerCase());
        return derivedKey ? { ...k, derivedKey } : { ...k };
    });
    return {
        keys,
        recovered: keys.filter(k => k.derivedKey).length,
        total: keys.length,
        interrupted: interrupted && derived.size < wanted.size,
    };
}

export interface SingleRecovery {
    derivedKey?: string;
    /** True if the user cancelled a signature before the key was found. */
    interrupted: boolean;
    /** How many signatures were requested. */
    attempts: number;
}

/**
 * Recover one key. Keys created by current code derive from the same index as
 * their slot, so that index is tried first — one signature in the normal case.
 * Only if it does not match are the other indexes tried (older keys, where slot
 * and derivation index could differ).
 */
export async function recoverOne(opts: {
    chainKey: ChainKey;
    derive: (i: number) => Promise<string>;
    commitmentOf: (apiKey: string) => string;
    maxScan: number;
}): Promise<SingleRecovery> {
    const { chainKey, derive, commitmentOf, maxScan } = opts;
    const wanted = chainKey.commitment.toLowerCase();
    const order = [chainKey.keyIndex, ...Array.from({ length: maxScan }, (_, i) => i).filter(i => i !== chainKey.keyIndex)];
    let attempts = 0;
    for (const i of order.slice(0, maxScan)) {
        attempts++;
        let apiKey: string;
        try {
            apiKey = await derive(i);
        } catch {
            return { interrupted: true, attempts };
        }
        if (commitmentOf(apiKey).toLowerCase() === wanted) return { derivedKey: apiKey, interrupted: false, attempts };
    }
    return { interrupted: false, attempts };
}
