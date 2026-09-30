// Private collections must actually be private. The RoutingAdapter once matched
// only synthetic `col:` keys, so real keys (`doc:…`, `idx:…`) always went to the
// public store and private collections were written in plaintext. These tests
// drive the real DocumentStore over a real RoutingAdapter + EncryptionLayer and
// inspect what each underlying store actually holds.

import { describe, it, expect } from 'vitest';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { RoutingAdapter } from '../storage/routing-adapter.js';
import { EncryptionLayer, createRegistryCodec } from '../storage/encryption-layer.js';
import { PrivacyManager } from '../storage/privacy-manager.js';

const ROOT = '7ca9aab926f23abfef41acc9bbae4c81e22c8cb52b7abd78da43533dfc3e3da6';
const ME = '0xb2ac1908cfb52debcca860ebcf538770e67df2b5';
const SECRET = 'top-secret-value-12345';
const SEP = String.fromCharCode(0x1f);

async function setup() {
    const publicKv = new InMemoryKVStore();
    const privateKv = new InMemoryKVStore();
    const routing = new RoutingAdapter(publicKv, new EncryptionLayer(privateKv, { privateKey: ROOT, enabled: true }));
    const privacy = new PrivacyManager(routing);
    routing.setPrivacyManager(privacy);
    const store = new DocumentStore(routing);
    const dump = async (kv: InMemoryKVStore) => (await kv.scan({ prefix: '', limit: 10000 }))
        .map((e) => `${e.key} => ${Buffer.from(e.value).toString('utf8')}`).join('\n');
    return { publicKv, privateKv, routing, privacy, store, dump };
}

describe('private collections', () => {
    it("never put a private collection's documents or indexed values on the public store", async () => {
        const { store, privacy, publicKv, privateKv, dump } = await setup();
        await privacy.setCollectionPrivacy('vault', 'private', ME);
        await store.insert('vault', [{ note: SECRET, email: 'alice@example.com' }]);
        await store.createIndex('vault', 'email');
        await store.insert('vault', [{ note: SECRET, email: 'bob@example.com' }]);

        const pub = await dump(publicKv);
        expect(pub).not.toContain(SECRET);
        expect(pub).not.toContain('bob@example.com');
        expect(pub).not.toMatch(/doc:vault:/);
        expect(pub).not.toMatch(/idx:vault:/);

        const priv = await dump(privateKv);
        expect(priv).toMatch(/doc:vault:/);   // it did land in the private store…
        expect(priv).not.toContain(SECRET);   // …but only as ciphertext
    });

    it('still reads, filters and counts private documents back correctly', async () => {
        const { store, privacy } = await setup();
        await privacy.setCollectionPrivacy('vault', 'private', ME);
        await store.insert('vault', [{ n: 1, tag: 'a' }, { n: 2, tag: 'b' }, { n: 3, tag: 'a' }]);
        await store.createIndex('vault', 'tag');
        const all = await store.find('vault', {});
        expect(all.cursor.firstBatch).toHaveLength(3);
        const tagged = await store.find('vault', { tag: 'a' });
        expect(tagged.cursor.firstBatch.map((d: any) => d.n).sort((a: number, b: number) => a - b)).toEqual([1, 3]);
    });

    it('public collections are untouched: plaintext on the public store, nothing on the private one', async () => {
        const { store, publicKv, privateKv, dump } = await setup();
        await store.insert('open', [{ note: SECRET }]);
        expect(await dump(publicKv)).toContain(SECRET);
        expect(await dump(privateKv)).toBe('');
    });

    it('migrates existing documents when a collection is made private, and back', async () => {
        const { store, privacy, routing, publicKv, dump } = await setup();
        await store.insert('later', [{ note: SECRET }]);
        expect(await dump(publicKv)).toContain(SECRET);

        const moved = await routing.migrateCollection('later', true, async () => {
            await privacy.setCollectionPrivacy('later', 'private', ME);
        });
        expect(moved).toBeGreaterThan(0);
        expect(await dump(publicKv)).not.toMatch(/doc:later:/);                     // live public copy removed
        expect((await store.find('later', {})).cursor.firstBatch).toHaveLength(1);  // still readable

        await routing.migrateCollection('later', false, async () => {
            await privacy.setCollectionPrivacy('later', 'public', ME);
        });
        expect((await store.find('later', {})).cursor.firstBatch[0]).toMatchObject({ note: SECRET });
    });

    it('reads keep working at the moment of the switch (originals are deleted only after it)', async () => {
        const { store, privacy, routing } = await setup();
        await store.insert('mid', [{ note: SECRET }]);
        let seenDuringSwitch = -1;
        await routing.migrateCollection('mid', true, async () => {
            await privacy.setCollectionPrivacy('mid', 'private', ME);
            seenDuringSwitch = (await store.find('mid', {})).cursor.firstBatch.length;
        });
        expect(seenDuringSwitch).toBe(1);
    });
});

describe('registry-log codec', () => {
    const codec = createRegistryCodec(ROOT);
    const key = Buffer.from(`idx:vault:email:3:alice@example.com${SEP}abc`, 'utf8');

    it('round-trips and hides the key text', () => {
        const enc = codec.encode(key);
        expect(enc.toString('utf8')).not.toContain('alice@example.com');
        expect(enc.toString('utf8')).not.toContain('vault');
        expect(codec.decode(enc).equals(key)).toBe(true);
    });

    it('passes legacy plaintext entries through unchanged', () => {
        expect(codec.decode(key).equals(key)).toBe(true);
    });

    it('rejects a tampered entry rather than returning garbage', () => {
        const enc = codec.encode(key);
        enc[enc.length - 1] ^= 0xff;
        expect(() => codec.decode(enc)).toThrow();
    });

    it('a different root key cannot decode it', () => {
        const other = createRegistryCodec('11'.repeat(32));
        expect(() => other.decode(codec.encode(key))).toThrow();
    });

    it('encrypts each entry differently even for the same key', () => {
        expect(codec.encode(key).equals(codec.encode(key))).toBe(false);
    });
});
