// Key-index snapshots (roadmap item 5): a restart loads the snapshot and replays
// only newer key-registry entries instead of the whole log (two RPC calls per
// entry ever written). The chain is a fake contract that counts calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';

vi.mock('../storage/tx-sequencer.js', () => ({
    sendContractTx: vi.fn(async () => ({})),
    confirmTx: vi.fn(async () => ({})),
}));

import { MonadAdapter } from '../storage/monaddb-adapter.js';
import { createRegistryCodec, type RegistryCodec } from '../storage/encryption-layer.js';
import { snapshotPath, writeKeyIndexSnapshot, readKeyIndexSnapshot } from '../storage/key-index-snapshot.js';
import * as txSequencer from '../storage/tx-sequencer.js';

const CONTRACT = '0x' + '1'.repeat(40);
const ROOT = '7ca9aab926f23abfef41acc9bbae4c81e22c8cb52b7abd78da43533dfc3e3da6';
const hex = (s: string) => ethers.hexlify(ethers.toUtf8Bytes(s));

/** A fake PlugPortStore: hash → hex value, with call counters. */
function fakeChain(codec?: RegistryCodec) {
    const slots = new Map<string, string>();
    let logged = 0;
    const calls = { get: 0, exists: 0 };
    const contract = {
        exists: vi.fn(async (h: string) => { calls.exists++; return slots.has(h); }),
        get: vi.fn(async (h: string) => { calls.get++; return slots.get(h) ?? '0x'; }),
        put: { populateTransaction: vi.fn(async () => ({})) },
        batchWrite: { populateTransaction: vi.fn(async () => ({})) },
    };
    /** Write a key the way MonadAdapter does: the value plus a registry log entry. */
    const write = (key: string) => {
        slots.set(ethers.id(key), hex(`value of ${key}`));
        const plain = Buffer.from(key);
        slots.set(ethers.id(`meta:kv-registry:${logged++}`), ethers.hexlify(codec ? codec.encode(plain) : plain));
    };
    return { contract, calls, write, slots };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pp-snap-')); vi.spyOn(console, 'log').mockImplementation(() => { }); vi.spyOn(console, 'warn').mockImplementation(() => { }); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

async function start(chain: ReturnType<typeof fakeChain>, codec?: RegistryCodec) {
    const skip = vi.spyOn(MonadAdapter.prototype as any, 'ensureKeyIndex').mockReturnValueOnce(Promise.resolve());
    const adapter = new MonadAdapter({ rpcUrl: 'http://127.0.0.1:1', chainId: 10143, privateKey: 'a'.repeat(64), contractAddress: CONTRACT, snapshotDir: dir, registryCodec: codec });
    skip.mockRestore();
    Object.assign(adapter as any, { contract: chain.contract });
    chain.calls.get = 0;
    await (adapter as any).ensureKeyIndex();
    return adapter;
}
const docKeys = async (a: MonadAdapter) => (await a.scan({ prefix: 'doc:' })).map((e) => e.key).sort();

describe('key-index snapshots', () => {
    it('a restart replays only the log entries written since the snapshot', async () => {
        const chain = fakeChain();
        for (let i = 0; i < 20; i++) chain.write(`doc:c:${String(i).padStart(2, '0')}`);

        await start(chain);
        expect(chain.calls.get).toBeGreaterThanOrEqual(20); // first start: full replay

        chain.write('doc:c:20');
        chain.write('doc:c:21');
        const restarted = await start(chain);
        expect(chain.calls.get).toBe(2); // only the two new registry entries
        const keys = await docKeys(restarted);
        expect(keys).toHaveLength(22);
        expect(keys).toContain('doc:c:21');
    });

    it('ignores a snapshot that claims more log entries than the chain has, and replays fully', async () => {
        const chain = fakeChain();
        for (let i = 0; i < 5; i++) chain.write(`doc:c:${i}`);
        await writeKeyIndexSnapshot(snapshotPath(dir, 10143, CONTRACT), CONTRACT, { upTo: 99, keys: ['doc:c:ghost'] });
        const adapter = await start(chain);
        expect(chain.calls.get).toBeGreaterThanOrEqual(5);
        expect(await docKeys(adapter)).not.toContain('doc:c:ghost');
    });

    it("encrypts a private store's snapshot and refuses a plaintext one", async () => {
        const codec = createRegistryCodec(ROOT);
        const chain = fakeChain(codec);
        chain.write('doc:vault:alice@example.com');
        await start(chain, codec);
        const file = snapshotPath(dir, 10143, CONTRACT);
        expect((await readFile(file)).toString('latin1')).not.toContain('alice@example.com');
        expect(await readKeyIndexSnapshot(file, CONTRACT, codec)).toMatchObject({ upTo: 1, keys: ['doc:vault:alice@example.com'] });

        await writeFile(file, JSON.stringify({ v: 1, contract: CONTRACT, upTo: 1, keys: ['doc:vault:planted'] }));
        expect(await readKeyIndexSnapshot(file, CONTRACT, codec)).toBeNull();
        expect(await readKeyIndexSnapshot(file, '0x' + '2'.repeat(40))).toBeNull(); // another contract
    });

    it('does not save a snapshot after a replay where entries failed (they must be retried next start)', async () => {
        const chain = fakeChain();
        for (let i = 0; i < 3; i++) chain.write(`doc:c:${i}`);
        const brokenEntry = ethers.id('meta:kv-registry:1');
        const realGet = chain.contract.get.getMockImplementation()!;
        chain.contract.get.mockImplementation(async (h: string) => { if (h === brokenEntry) throw new Error('missing revert data'); return realGet(h); });
        vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0 as unknown as NodeJS.Timeout; }) as typeof setTimeout);
        await start(chain);
        vi.mocked(globalThis.setTimeout).mockRestore();
        expect(await readKeyIndexSnapshot(snapshotPath(dir, 10143, CONTRACT), CONTRACT)).toBeNull();
    });

    it('reserves one log entry for concurrent writes of the same new key, and releases it if the write fails', async () => {
        const chain = fakeChain();
        const adapter = await start(chain);
        await Promise.all([adapter.put('doc:c:same', Buffer.from('a')), adapter.put('doc:c:same', Buffer.from('b'))]);
        expect((adapter as any).registryCount).toBe(1);

        vi.mocked(txSequencer.confirmTx).mockRejectedValueOnce(new Error('reverted'));
        await expect(adapter.put('doc:c:fails', Buffer.from('x'))).rejects.toThrow('reverted');
        expect((adapter as any).keyIndex.has('doc:c:fails')).toBe(false);
    });
});
