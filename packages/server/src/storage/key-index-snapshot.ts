// Snapshots of a contract's key index, so a restart doesn't replay the whole
// key-registry log (roadmap item 5).
//
// MonadAdapter rebuilds its in-memory key index from an append-only log on
// chain, two RPC calls per entry ever written: ~1,000 calls (~40s under the RPC
// limit) on testnet today, hours at 100,000 keys, and once per customer store.
// A snapshot records the live keys and how far into the log they cover; a
// restart loads it and replays only newer entries.
//
// It is a cache, not the source of truth: kept on the server's disk (a Docker
// volume) rather than on chain, where storing it would cost over 1 MON per
// snapshot and grow with the data. If it is missing, unreadable, encrypted with
// a different key, or for another contract, the adapter falls back to a full
// replay, so nothing can be lost. For a private store the key list contains
// document ids and indexed values, so the file is encrypted with that store's
// registry codec, and a plaintext file is refused.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RegistryCodec } from './encryption-layer.js';

const FORMAT_VERSION = 1;
const CODEC_MAGIC = Buffer.from('PPR1'); // what RegistryCodec.encode output starts with

export interface KeyIndexSnapshot {
    /** Log entries [0, upTo) are reflected in `keys`. */
    upTo: number;
    /** The live plaintext keys known at snapshot time. */
    keys: string[];
}

export function snapshotPath(dir: string, chainId: number, contract: string): string {
    return join(dir, `${chainId}-${contract.toLowerCase()}.snapshot`);
}

export async function writeKeyIndexSnapshot(path: string, contract: string, snapshot: KeyIndexSnapshot, codec?: RegistryCodec): Promise<void> {
    const body = Buffer.from(JSON.stringify({ v: FORMAT_VERSION, contract: contract.toLowerCase(), upTo: snapshot.upTo, keys: snapshot.keys }));
    const data = codec ? codec.encode(body) : body;
    await mkdir(dirname(path), { recursive: true });
    // Write then rename, so a crash mid-write never leaves a truncated snapshot.
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, data);
    await rename(tmp, path);
}

/** The snapshot at `path`, or null if there is none or it can't be trusted. */
export async function readKeyIndexSnapshot(path: string, contract: string, codec?: RegistryCodec): Promise<KeyIndexSnapshot | null> {
    let data: Buffer;
    try {
        data = await readFile(path);
    } catch {
        return null;
    }
    try {
        const encrypted = data.subarray(0, CODEC_MAGIC.length).equals(CODEC_MAGIC);
        if (codec && !encrypted) return null; // a private store's snapshot must be encrypted
        if (!codec && encrypted) return null;
        const parsed = JSON.parse((codec ? codec.decode(data) : data).toString('utf8'));
        if (parsed?.v !== FORMAT_VERSION || parsed.contract !== contract.toLowerCase()) return null;
        if (!Number.isInteger(parsed.upTo) || parsed.upTo < 0) return null;
        if (!Array.isArray(parsed.keys) || !parsed.keys.every((k: unknown) => typeof k === 'string')) return null;
        return { upTo: parsed.upTo, keys: parsed.keys };
    } catch {
        return null; // tampered, wrong key, or not JSON
    }
}
