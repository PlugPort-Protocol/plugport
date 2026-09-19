// The Multicall3 read path against a local mock RPC that really decodes the
// aggregate3 calldata and answers from a fake PlugPortAuth state — so the real
// ABI encoding/decoding runs, offline. Also pins the property that motivated it:
// a wallet's key state costs a fixed number of RPC calls however many keys it has.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ethers } from 'ethers';

const AUTH_ABI = [
    'function getActiveKeys(address addr) view returns (uint8[])',
    'function nonces(address) view returns (uint256)',
    'function getCommitment(address addr, uint8 keyIndex) view returns (bytes32)',
    'function getVerifier(address addr, uint8 keyIndex) view returns (bytes32 salt, bytes32 storedKey, bytes32 serverKey, bool active)',
];
const MC_ABI = ['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)'];
const authIface = new ethers.Interface(AUTH_ABI);
const mcIface = new ethers.Interface(MC_ABI);

const CONTRACT = '0x43E7D9F6409bF7C97510fff7d8ccB80adD826E50';
const WALLET = '0xb2ac1908cfb52debcca860ebcf538770e67df2b5';
const b32 = (tag: string, i: number) => ethers.zeroPadValue(ethers.toBeHex(i * 1000 + tag.charCodeAt(0)), 32);

let server: http.Server;
let calls = { total: 0, multicall: 0 };
let state = { indices: [0, 3, 7], nonce: 25n };
let failMulticall = false;

/** Answer one auth-contract call from the fake state. */
function answer(callData: string): string {
    const fn = authIface.getFunction(callData.slice(0, 10))!;
    const args = authIface.decodeFunctionData(fn, callData);
    switch (fn.name) {
        case 'getActiveKeys': return authIface.encodeFunctionResult(fn, [state.indices]);
        case 'nonces': return authIface.encodeFunctionResult(fn, [state.nonce]);
        case 'getCommitment': return authIface.encodeFunctionResult(fn, [b32('c', Number(args[1]))]);
        case 'getVerifier': return authIface.encodeFunctionResult(fn, [b32('s', Number(args[1])), b32('k', Number(args[1])), b32('v', Number(args[1])), true]);
        default: throw new Error('unexpected ' + fn.name);
    }
}

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
            const rpc = JSON.parse(raw);
            calls.total++;
            const reply = (result: string) => res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
            res.setHeader('content-type', 'application/json');
            if (rpc.method !== 'eth_call') return reply('0x0');
            const { to, data } = rpc.params[0];
            if (to.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') {
                calls.multicall++;
                if (failMulticall) return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'execution reverted' } }));
                const [subcalls] = mcIface.decodeFunctionData('aggregate3', data);
                const results = subcalls.map((c: { callData: string }) => ({ success: true, returnData: answer(c.callData) }));
                return reply(mcIface.encodeFunctionResult('aggregate3', [results]));
            }
            return reply(answer(data)); // direct call (per-call fallback path)
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.MONAD_RPC_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.AUTH_CONTRACT_ADDRESS = CONTRACT;
    delete process.env.AUTH_GAS_STATION_PRIVATE_KEYS;
    delete process.env.AUTH_GAS_STATION_PRIVATE_KEY;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { calls = { total: 0, multicall: 0 }; failMulticall = false; state = { indices: [0, 3, 7], nonce: 25n }; });

async function makeAdapter() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { AuthContractAdapter } = await import('../auth/auth-contract.js');
    return new AuthContractAdapter();
}

describe('getKeyState via Multicall3', () => {
    it('decodes the keys and nonce correctly through the real ABI encoding', async () => {
        const a = await makeAdapter();
        const { activeKeys, nonce } = await a.getKeyState(WALLET);
        expect(nonce).toBe(25);
        expect(activeKeys.map((k) => k.keyIndex)).toEqual([0, 3, 7]);
        expect(activeKeys[1]).toMatchObject({
            keyIndex: 3, commitment: b32('c', 3), salt: b32('s', 3), storedKey: b32('k', 3), serverKey: b32('v', 3), active: true,
        });
    });

    it('costs exactly two RPC calls however many keys the wallet has', async () => {
        const a = await makeAdapter();
        for (const n of [1, 3, 10, 25]) {
            state = { indices: Array.from({ length: n }, (_, i) => i), nonce: 1n };
            calls = { total: 0, multicall: 0 };
            expect((await a.getKeyState(WALLET)).activeKeys).toHaveLength(n);
            expect(calls.total).toBe(2);
        }
    });

    it('a wallet with no keys costs one call and returns its nonce', async () => {
        state = { indices: [], nonce: 9n };
        const a = await makeAdapter();
        expect(await a.getKeyState(WALLET)).toEqual({ activeKeys: [], nonce: 9 });
        expect(calls.total).toBe(1);
    });

    it('falls back to individual calls when Multicall3 is unavailable — same answer', async () => {
        const a = await makeAdapter();
        const viaMulticall = await a.getKeyState(WALLET);
        failMulticall = true;
        calls = { total: 0, multicall: 0 };
        const viaFallback = await a.getKeyState(WALLET);
        expect(viaFallback).toEqual(viaMulticall);
        expect(calls.total).toBeGreaterThan(2); // the slow path really ran
    });

    it('getActiveKeys uses the same path', async () => {
        const a = await makeAdapter();
        expect((await a.getActiveKeys(WALLET)).map((k) => k.keyIndex)).toEqual([0, 3, 7]);
    });
});
