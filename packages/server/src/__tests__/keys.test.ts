// Wallet-role / secret resolution. One key used to be the store writer, the
// contract owner, the AES root and the session seed all at once; these tests
// pin down how the roles are split without breaking single-key deployments
// or — most importantly — orphaning data already encrypted under the old key.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { resolveKeys, describeRoles, logWalletRoles } from '../keys.js';
import { deriveSessionSecret } from '../auth/session.js';
import { EncryptionLayer } from '../storage/encryption-layer.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';

const newKey = () => ethers.Wallet.createRandom().privateKey.slice(2); // no 0x, like the env files

describe('resolveKeys', () => {
    it('a legacy single-key config gives every role that one key (behavior unchanged)', () => {
        const k = newKey();
        expect(resolveKeys({ MONAD_PRIVATE_KEY: k })).toEqual({
            store: k, privateStore: k, broker: k, encryption: k,
        });
    });

    it('per-role keys override the legacy key independently', () => {
        const legacy = newKey(), store = newKey(), priv = newKey(), broker = newKey(), enc = newKey();
        expect(resolveKeys({
            MONAD_PRIVATE_KEY: legacy,
            STORE_PRIVATE_KEY: store,
            PRIVATE_STORE_PRIVATE_KEY: priv,
            MESSAGEBROKER_PRIVATE_KEY: broker,
            ENCRYPTION_KEY: enc,
        })).toEqual({ store, privateStore: priv, broker, encryption: enc });
    });

    it('roles left unset fall back to the store key, so partial configs stay working', () => {
        const store = newKey(), broker = newKey();
        const r = resolveKeys({ STORE_PRIVATE_KEY: store, MESSAGEBROKER_PRIVATE_KEY: broker });
        expect(r.privateStore).toBe(store);
        expect(r.broker).toBe(broker);
    });

    it('the encryption root prefers the legacy key over the store key, so existing data keeps decrypting', () => {
        const legacy = newKey(), store = newKey();
        expect(resolveKeys({ MONAD_PRIVATE_KEY: legacy, STORE_PRIVATE_KEY: store }).encryption).toBe(legacy);
    });

    it('treats empty or whitespace-only values as unset (docker-compose passes unset vars as "")', () => {
        const legacy = newKey();
        const r = resolveKeys({ MONAD_PRIVATE_KEY: legacy, STORE_PRIVATE_KEY: '', ENCRYPTION_KEY: '   ' });
        expect(r.store).toBe(legacy);
        expect(r.encryption).toBe(legacy);
    });

    it('resolves nothing when nothing is configured', () => {
        expect(resolveKeys({})).toEqual({ store: undefined, privateStore: undefined, broker: undefined, encryption: undefined });
    });
});

describe('describeRoles', () => {
    it('reports every role and flags a single shared wallet', () => {
        const k = newKey();
        const report = describeRoles(resolveKeys({ MONAD_PRIVATE_KEY: k }), k);
        expect(report.roles.map((r) => r.role).sort()).toEqual(['auth', 'broker', 'privateStore', 'store']);
        expect(report.shared).toHaveLength(1);
        expect(report.shared[0].roles.sort()).toEqual(['auth', 'broker', 'privateStore', 'store']);
        expect(report.encryptionSeparate).toBe(false);
    });

    it('reports no sharing and a separate encryption root once the roles are split', () => {
        const report = describeRoles(
            resolveKeys({
                STORE_PRIVATE_KEY: newKey(),
                PRIVATE_STORE_PRIVATE_KEY: newKey(),
                MESSAGEBROKER_PRIVATE_KEY: newKey(),
                ENCRYPTION_KEY: newKey(),
            }),
            newKey(),
        );
        expect(report.shared).toEqual([]);
        expect(report.encryptionSeparate).toBe(true);
    });

    it('recognises the same wallet regardless of 0x prefix or case', () => {
        const k = newKey();
        const report = describeRoles(
            resolveKeys({ STORE_PRIVATE_KEY: k, MESSAGEBROKER_PRIVATE_KEY: `0x${k.toUpperCase()}` }),
            undefined,
        );
        expect(report.shared).toHaveLength(1);
        expect(report.shared[0].roles).toContain('store');
        expect(report.shared[0].roles).toContain('broker');
    });

    it('lists each configured Auth relayer key', () => {
        const report = describeRoles(resolveKeys({ STORE_PRIVATE_KEY: newKey() }), `${newKey()},${newKey()}`);
        expect(report.roles.filter((r) => r.role === 'auth')).toHaveLength(2);
    });

    it('flags an encryption root that is really a signing wallet key', () => {
        const k = newKey();
        const report = describeRoles({ store: k, encryption: k });
        expect(report.encryptionSeparate).toBe(false);
    });
});

describe('logWalletRoles', () => {
    afterEach(() => vi.restoreAllMocks());

    it('prints addresses only — never a private key', () => {
        const k = newKey();
        const lines: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(a.join(' ')); });
        vi.spyOn(console, 'warn').mockImplementation((...a) => { lines.push(a.join(' ')); });
        logWalletRoles(resolveKeys({ MONAD_PRIVATE_KEY: k }), k);
        const out = lines.join('\n');
        expect(out).toContain('WARNING');
        expect(out).not.toContain(k);
    });
});

describe('the data-loss guard: splitting keys must not orphan encrypted data', () => {
    it('data encrypted under the old single-key config still decrypts under the split config', async () => {
        const oldKey = newKey();

        // Before: one key does everything, including deriving the AES key.
        const store = new InMemoryKVStore();
        const before = new EncryptionLayer(store, { privateKey: resolveKeys({ MONAD_PRIVATE_KEY: oldKey }).encryption!, enabled: true });
        await before.put('doc:secret', Buffer.from('private collection payload'));

        // After: brand-new wallets sign everything; the retired key lives on only
        // as ENCRYPTION_KEY, so the derived AES key is byte-for-byte the same.
        const after = new EncryptionLayer(store, {
            privateKey: resolveKeys({
                STORE_PRIVATE_KEY: newKey(),
                PRIVATE_STORE_PRIVATE_KEY: newKey(),
                MESSAGEBROKER_PRIVATE_KEY: newKey(),
                ENCRYPTION_KEY: oldKey,
            }).encryption!,
            enabled: true,
        });

        expect((await after.get('doc:secret'))!.toString()).toBe('private collection payload');
    });

    it('and a naive key swap WOULD have orphaned it (why ENCRYPTION_KEY exists)', async () => {
        const store = new InMemoryKVStore();
        const before = new EncryptionLayer(store, { privateKey: newKey(), enabled: true });
        await before.put('doc:secret', Buffer.from('payload'));

        const naive = new EncryptionLayer(store, { privateKey: newKey(), enabled: true });
        await expect(naive.get('doc:secret')).rejects.toThrow();
    });
});

describe('deriveSessionSecret', () => {
    it('is independent of the wallet key when SESSION_SECRET is set', () => {
        const a = deriveSessionSecret({ SESSION_SECRET: 's1', MONAD_PRIVATE_KEY: newKey() });
        const b = deriveSessionSecret({ SESSION_SECRET: 's1', MONAD_PRIVATE_KEY: newKey() });
        expect(a).toBe(b);
    });

    it('differs for different SESSION_SECRETs', () => {
        expect(deriveSessionSecret({ SESSION_SECRET: 's1' })).not.toBe(deriveSessionSecret({ SESSION_SECRET: 's2' }));
    });

    it('falls back to the legacy key so existing deployments keep their sessions', () => {
        const k = newKey();
        expect(deriveSessionSecret({ MONAD_PRIVATE_KEY: k })).toBe(deriveSessionSecret({ MONAD_PRIVATE_KEY: k }));
        expect(deriveSessionSecret({ MONAD_PRIVATE_KEY: k })).not.toBe(deriveSessionSecret({ SESSION_SECRET: k + 'x' }));
    });

    it('is random per call when nothing is configured (dev mode)', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(deriveSessionSecret({})).not.toBe(deriveSessionSecret({}));
        vi.restoreAllMocks();
    });
});
