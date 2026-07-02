// T2: RoutingAdapter routing logic tests
// Validates privacy-based routing, global scan merging, and count aggregation.

import { describe, it, expect, beforeEach } from 'vitest';
import { RoutingAdapter } from '../storage/routing-adapter.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { PrivacyManager } from '../storage/privacy-manager.js';

describe('RoutingAdapter', () => {
    let publicAdapter: InMemoryKVStore;
    let privateAdapter: InMemoryKVStore;
    let metaAdapter: InMemoryKVStore; // For PrivacyManager's own KV
    let routing: RoutingAdapter;
    let privacyManager: PrivacyManager;

    beforeEach(() => {
        publicAdapter = new InMemoryKVStore();
        privateAdapter = new InMemoryKVStore();
        metaAdapter = new InMemoryKVStore();
        routing = new RoutingAdapter(publicAdapter, privateAdapter);
        privacyManager = new PrivacyManager(metaAdapter);
        routing.setPrivacyManager(privacyManager);
    });

    // ---- Basic routing ----

    it('should route meta: prefix keys to public adapter', async () => {
        await routing.put('meta:privacy:users', Buffer.from('test'));
        const result = await publicAdapter.get('meta:privacy:users');
        expect(result).toBeTruthy();
        const privateResult = await privateAdapter.get('meta:privacy:users');
        expect(privateResult).toBeNull();
    });

    it('should route analytics: prefix keys to public adapter', async () => {
        await routing.put('analytics:daily:2024-01-01', Buffer.from('data'));
        expect(await publicAdapter.get('analytics:daily:2024-01-01')).toBeTruthy();
        expect(await privateAdapter.get('analytics:daily:2024-01-01')).toBeNull();
    });

    it('should route public collection keys to public adapter by default', async () => {
        await routing.put('col:users:doc:abc', Buffer.from('doc'));
        expect(await publicAdapter.get('col:users:doc:abc')).toBeTruthy();
    });

    it('should route private collection keys to private adapter', async () => {
        // Set up collection as private
        await privacyManager.setCollectionPrivacy('secrets', 'private', '0x1234');

        await routing.put('col:secrets:doc:xyz', Buffer.from('encrypted'));
        expect(await privateAdapter.get('col:secrets:doc:xyz')).toBeTruthy();
        expect(await publicAdapter.get('col:secrets:doc:xyz')).toBeNull();
    });

    it('should read private collection keys from private adapter', async () => {
        await privacyManager.setCollectionPrivacy('secrets', 'private', '0x1234');

        // Write directly to private adapter
        await privateAdapter.put('col:secrets:doc:1', Buffer.from('secret-data'));

        // RoutingAdapter should find it
        const result = await routing.get('col:secrets:doc:1');
        expect(result).toBeTruthy();
        expect(result!.toString()).toBe('secret-data');
    });

    // ---- Global scan merge (A7) ----

    it('should merge public + private results for global scans', async () => {
        await publicAdapter.put('key:1', Buffer.from('pub1'));
        await publicAdapter.put('key:2', Buffer.from('pub2'));
        await privateAdapter.put('key:3', Buffer.from('priv1'));

        const results = await routing.scan({ prefix: 'key:' });
        expect(results.length).toBe(3);
    });

    it('should respect limit on merged scan results', async () => {
        await publicAdapter.put('key:1', Buffer.from('pub1'));
        await publicAdapter.put('key:2', Buffer.from('pub2'));
        await privateAdapter.put('key:3', Buffer.from('priv1'));
        await privateAdapter.put('key:4', Buffer.from('priv2'));

        const results = await routing.scan({ prefix: 'key:', limit: 2 });
        expect(results.length).toBe(2);
    });

    it('should not double-count when public and private are same adapter', async () => {
        const shared = new InMemoryKVStore();
        const sharedRouting = new RoutingAdapter(shared, shared);

        await shared.put('key:1', Buffer.from('data1'));
        await shared.put('key:2', Buffer.from('data2'));

        const results = await sharedRouting.scan({ prefix: 'key:' });
        expect(results.length).toBe(2); // Not 4
    });

    // ---- Global count merge (A7) ----

    it('should sum counts from both adapters for global count', async () => {
        await publicAdapter.put('key:a', Buffer.from('1'));
        await publicAdapter.put('key:b', Buffer.from('2'));
        await privateAdapter.put('key:c', Buffer.from('3'));

        const count = await routing.count('key:');
        expect(count).toBe(3);
    });

    it('should not double-count when same adapter on count', async () => {
        const shared = new InMemoryKVStore();
        const sharedRouting = new RoutingAdapter(shared, shared);

        await shared.put('key:1', Buffer.from('data'));
        await shared.put('key:2', Buffer.from('data'));

        const count = await sharedRouting.count('key:');
        expect(count).toBe(2);
    });

    // ---- Metadata scans stay public-only ----

    it('should not merge private adapter for meta: scans', async () => {
        await publicAdapter.put('meta:x', Buffer.from('pub'));
        await privateAdapter.put('meta:y', Buffer.from('priv'));

        const results = await routing.scan({ prefix: 'meta:' });
        expect(results.length).toBe(1);
        expect(results[0].key).toBe('meta:x');
    });

    it('should not merge private adapter for analytics: count', async () => {
        await publicAdapter.put('analytics:a', Buffer.from('1'));
        await privateAdapter.put('analytics:b', Buffer.from('2'));

        const count = await routing.count('analytics:');
        expect(count).toBe(1); // Only public
    });

    // ---- batchWrite routing ----

    it('should route batch writes to correct adapters based on key prefix', async () => {
        await privacyManager.setCollectionPrivacy('private_col', 'private', '0x1234');

        await routing.batchWrite(
            [
                { key: 'col:public_col:doc:1', value: Buffer.from('pub-doc') },
                { key: 'col:private_col:doc:1', value: Buffer.from('priv-doc') },
                { key: 'meta:test', value: Buffer.from('meta-data') },
            ],
            []
        );

        expect(await publicAdapter.get('col:public_col:doc:1')).toBeTruthy();
        expect(await privateAdapter.get('col:private_col:doc:1')).toBeTruthy();
        expect(await publicAdapter.get('meta:test')).toBeTruthy();
    });

    // ---- Delete routing ----

    it('should delete from private adapter for private collections', async () => {
        await privacyManager.setCollectionPrivacy('secrets', 'private', '0x1234');
        await privateAdapter.put('col:secrets:doc:1', Buffer.from('secret'));

        await routing.delete('col:secrets:doc:1');
        expect(await privateAdapter.get('col:secrets:doc:1')).toBeNull();
    });

    // ---- Clear ----

    it('should clear both adapters', async () => {
        await publicAdapter.put('a', Buffer.from('1'));
        await privateAdapter.put('b', Buffer.from('2'));

        await routing.clear();

        expect(await publicAdapter.get('a')).toBeNull();
        expect(await privateAdapter.get('b')).toBeNull();
    });

    // ---- Edge case: no privacyManager set ----

    it('should default all keys to public adapter when privacyManager not set', async () => {
        const noPmRouting = new RoutingAdapter(publicAdapter, privateAdapter);
        // Do NOT call setPrivacyManager

        await noPmRouting.put('col:secrets:doc:1', Buffer.from('should-go-public'));
        expect(await publicAdapter.get('col:secrets:doc:1')).toBeTruthy();
        expect(await privateAdapter.get('col:secrets:doc:1')).toBeNull();
    });
});
