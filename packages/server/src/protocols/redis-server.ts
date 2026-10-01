// PlugPort Redis RESP Protocol Server
// Implements Redis Serialization Protocol (RESP2).
// Accepts connections from ioredis, node-redis, redis-cli.
// Maps Redis commands to DocumentStore / KVAdapter / MessageBrokerAdapter.
//
// Supported command groups:
//   - String: GET, SET, DEL, MGET, MSET, INCR, DECR, APPEND, STRLEN, SETNX, SETEX
//   - Hash:   HSET, HGET, HGETALL, HDEL, HMSET, HMGET, HKEYS, HVALS, HEXISTS, HLEN
//   - List:   LPUSH, RPUSH, LPOP, RPOP, LLEN, LRANGE (via Sorted Sets on Monad)
//   - Set:    SADD, SREM, SMEMBERS, SISMEMBER, SCARD
//   - Sorted Set: ZADD, ZREM, ZRANGE, ZRANGEBYSCORE, ZSCORE, ZCARD
//   - Key:    EXISTS, TYPE, KEYS, TTL, PERSIST, RENAME, EXPIRE (TTL is application-level)
//   - Pub/Sub: SUBSCRIBE, PUBLISH, UNSUBSCRIBE, PSUBSCRIBE
//   - Server: PING, INFO, DBSIZE, FLUSHDB, SELECT, AUTH, COMMAND

import net from 'net';
import { timingSafeEqual } from 'node:crypto';
import type { DocumentStore } from '../storage/document-store.js';
import type { KVAdapter } from '@plugport/shared';
import type { ProtocolServerInstance } from './protocol-manager.js';
import { PRE_AUTH_MAX_BYTES, REDIS_MAX_BUFFER_BYTES, REDIS_MAX_ARRAY_ELEMENTS, MAX_CONNECTIONS_PER_PROTOCOL, closeUnlessAuthenticatedWithin } from './connection-limits.js';
import type { MetricsCollector } from '../metrics.js';
import type { ProtocolType } from '@plugport/shared';
import { acceptMaybeTls, isSecure, type WireTls } from './wire-tls.js';
import { resolveScramCredentials, verifyScramPassword, isWalletLogin } from '../auth/scram.js';

type RedisType = 'str' | 'hash' | 'list' | 'set' | 'zset';
const REDIS_TYPES: RedisType[] = ['str', 'hash', 'list', 'set', 'zset'];

/**
 * Where a connection's Redis data lives. The operator (master key) uses the
 * shared keyspace; a wallet that logged in with one of its API keys has its
 * own, under `redis:w:<wallet>:` — so the shared keyspace's scans never reach
 * it — and its pub/sub channels are its own too.
 */
export class RedisKeyspace {
    constructor(readonly wallet?: string) {}

    private get root(): string {
        return this.wallet ? `redis:w:${this.wallet}:` : 'redis:';
    }

    key(type: RedisType, name: string): string {
        return `${this.prefix(type)}${name}`;
    }

    prefix(type: RedisType): string {
        return `${this.root}${type}:`;
    }

    get prefixes(): string[] {
        return REDIS_TYPES.map((t) => this.prefix(t));
    }

    channel(name: string): string {
        return this.wallet ? `${this.wallet}:${name}` : name;
    }
}

/** Constant-time string comparison to prevent timing attacks on the Redis AUTH password. */
function safeCompare(a: string, b: string): boolean {
    try {
        const bufA = Buffer.from(a, 'utf-8');
        const bufB = Buffer.from(b, 'utf-8');
        if (bufA.length !== bufB.length) {
            timingSafeEqual(bufA, bufA);
            return false;
        }
        return timingSafeEqual(bufA, bufB);
    } catch {
        return false;
    }
}

/** Commands allowed before AUTH succeeds, when an API key is configured. */
const UNPROTECTED_REDIS_COMMANDS = new Set(['AUTH', 'HELLO', 'PING', 'QUIT']);

// ---- RESP Parser ----

interface RESPValue {
    type: 'string' | 'error' | 'integer' | 'bulk' | 'array' | 'null';
    value: string | number | null | RESPValue[];
}

/** Bounds on what a client may send; server replies are parsed without them. */
export interface RespLimits {
    maxBulkBytes: number;
    maxArrayElements: number;
}

/** Input a client should never send. The connection cannot recover, so it is closed. */
export class RespLimitError extends Error {}

const CLIENT_RESP_LIMITS: RespLimits = { maxBulkBytes: REDIS_MAX_BUFFER_BYTES, maxArrayElements: REDIS_MAX_ARRAY_ELEMENTS };

/**
 * Parse one RESP value. With `limits` (client input), oversized lengths, huge
 * arrays and nested arrays — commands are flat arrays of bulk strings — throw
 * RespLimitError before anything is allocated for them.
 */
export function parseRESP(data: Buffer, limits?: RespLimits, depth = 0): { value: RESPValue; bytesConsumed: number } | null {
    if (data.length === 0) return null;

    const type = String.fromCharCode(data[0]);
    const crlfIndex = data.indexOf('\r\n');
    if (crlfIndex === -1) return null;

    switch (type) {
        case '+': { // Simple string
            const value = data.subarray(1, crlfIndex).toString('utf-8');
            return { value: { type: 'string', value }, bytesConsumed: crlfIndex + 2 };
        }

        case '-': { // Error
            const value = data.subarray(1, crlfIndex).toString('utf-8');
            return { value: { type: 'error', value }, bytesConsumed: crlfIndex + 2 };
        }

        case ':': { // Integer
            const value = parseInt(data.subarray(1, crlfIndex).toString('utf-8'), 10);
            return { value: { type: 'integer', value }, bytesConsumed: crlfIndex + 2 };
        }

        case '$': { // Bulk string
            const length = parseInt(data.subarray(1, crlfIndex).toString('utf-8'), 10);
            if (limits && !(length >= -1 && length <= limits.maxBulkBytes)) {
                throw new RespLimitError(`Protocol error: invalid bulk length`);
            }
            if (length === -1) {
                return { value: { type: 'null', value: null }, bytesConsumed: crlfIndex + 2 };
            }
            const start = crlfIndex + 2;
            if (data.length < start + length + 2) return null;
            const value = data.subarray(start, start + length).toString('utf-8');
            return { value: { type: 'bulk', value }, bytesConsumed: start + length + 2 };
        }

        case '*': { // Array
            const count = parseInt(data.subarray(1, crlfIndex).toString('utf-8'), 10);
            if (limits && (depth > 0 || !(count >= -1 && count <= limits.maxArrayElements))) {
                throw new RespLimitError(depth > 0 ? 'Protocol error: nested arrays are not supported' : 'Protocol error: invalid multibulk length');
            }
            if (count === -1) {
                return { value: { type: 'null', value: null }, bytesConsumed: crlfIndex + 2 };
            }

            let offset = crlfIndex + 2;
            const elements: RESPValue[] = [];

            for (let i = 0; i < count; i++) {
                const result = parseRESP(data.subarray(offset), limits, depth + 1);
                if (!result) return null;
                elements.push(result.value);
                offset += result.bytesConsumed;
            }

            return { value: { type: 'array', value: elements }, bytesConsumed: offset };
        }

        default: {
            // Inline command (redis-cli sends plain text)
            const line = data.subarray(0, crlfIndex).toString('utf-8');
            const parts = line.split(/\s+/).filter(s => s.length > 0);
            const elements = parts.map(p => ({ type: 'bulk' as const, value: p }));
            return { value: { type: 'array', value: elements }, bytesConsumed: crlfIndex + 2 };
        }
    }
}

// ---- RESP Encoder ----

function encodeSimpleString(str: string): Buffer {
    return Buffer.from(`+${str}\r\n`);
}

function encodeError(msg: string): Buffer {
    return Buffer.from(`-ERR ${msg}\r\n`);
}

function encodeInteger(num: number): Buffer {
    return Buffer.from(`:${num}\r\n`);
}

function encodeBulkString(str: string | null): Buffer {
    if (str === null) return Buffer.from('$-1\r\n');
    return Buffer.from(`$${Buffer.byteLength(str)}\r\n${str}\r\n`);
}

function encodeArray(items: Buffer[]): Buffer {
    const header = Buffer.from(`*${items.length}\r\n`);
    return Buffer.concat([header, ...items]);
}

// ---- Redis Server ----

export class RedisServer implements ProtocolServerInstance {
    name: ProtocolType = 'redis';
    server: net.Server | null = null;
    port: number;
    connections: number = 0;
    private host: string;
    private store: DocumentStore;
    private kvStore: KVAdapter;
    private activeConnections: Set<net.Socket> = new Set();
    private subscribedClients: Map<string, Set<net.Socket>> = new Map(); // channel → sockets
    private messageBroker: any; // MessageBrokerAdapter (optional)
    private apiKey?: string;
    private authenticatedSockets: WeakSet<object> = new WeakSet();
    /** The wallet a connection logged in as (AUTH <wallet> <api key>); absent for the master key. */
    private wallets: WeakMap<object, string> = new WeakMap();
    private metrics?: MetricsCollector;
    private tls?: WireTls;

    constructor(options: {
        store: DocumentStore;
        kvStore: KVAdapter;
        port?: number;
        host?: string;
        messageBroker?: any;
        apiKey?: string;
        metrics?: MetricsCollector;
        /** Also accept TLS clients (rediss://) on the same port; wallet logins require it. */
        tls?: WireTls;
    }) {
        this.store = options.store;
        this.kvStore = options.kvStore;
        this.port = options.port || 6379;
        this.host = options.host || '0.0.0.0';
        this.messageBroker = options.messageBroker || null;
        this.apiKey = options.apiKey;
        this.metrics = options.metrics;
        this.tls = options.tls;
    }

    async start(): Promise<void> {
        if (this.server) return;

        return new Promise((resolve, reject) => {
            this.server = net.createServer((socket) => acceptMaybeTls(socket, this.tls, (conn) => this.handleConnection(conn)));
            this.server.maxConnections = MAX_CONNECTIONS_PER_PROTOCOL;
            this.server.on('error', reject);
            this.server.listen(this.port, this.host, () => {
                console.log(`[PlugPort] Redis protocol listening on ${this.host}:${this.port}`);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.server) return;

        for (const socket of this.activeConnections) {
            socket.destroy();
        }
        this.activeConnections.clear();
        this.subscribedClients.clear();

        return new Promise((resolve) => {
            this.server!.close(() => {
                this.server = null;
                this.connections = 0;
                resolve();
            });
        });
    }

    getConnectionCount(): number {
        return this.activeConnections.size;
    }

    // ---- Connection Handler ----

    private handleConnection(socket: net.Socket): void {
        this.activeConnections.add(socket);
        this.connections++;
        this.metrics?.connectionOpened('wire');

        // 'error' is typically followed by 'close' for the same socket —
        // guard so a single real disconnect isn't counted twice.
        let disconnected = false;
        const onDisconnect = () => {
            if (disconnected) return;
            disconnected = true;
            this.removeSubscriptions(socket);
            this.activeConnections.delete(socket);
            this.connections--;
            this.metrics?.connectionClosed('wire');
        };

        let buffer = Buffer.alloc(0);

        const authenticated = () => !this.apiKey || this.authenticatedSockets.has(socket);
        if (this.apiKey) closeUnlessAuthenticatedWithin(socket, authenticated);

        socket.on('data', async (data) => {
            buffer = Buffer.concat([buffer, data]);
            // Parsed commands are larger than their bytes (see connection-limits.ts).
            if (buffer.length > (authenticated() ? REDIS_MAX_BUFFER_BYTES : PRE_AUTH_MAX_BYTES)) {
                socket.destroy();
                buffer = Buffer.alloc(0);
                return;
            }

            try {
                while (buffer.length > 0) {
                    const result = parseRESP(buffer, CLIENT_RESP_LIMITS);
                    if (!result) break; // Incomplete message

                    buffer = buffer.subarray(result.bytesConsumed);
                    const command = this.extractCommand(result.value);
                    if (command) {
                        const startTime = Date.now();
                        let success = true;
                        try {
                            await this.executeCommand(socket, command);
                        } catch (err) {
                            success = false;
                            throw err;
                        } finally {
                            this.metrics?.recordRequest((command[0] || 'UNKNOWN').toUpperCase(), 'wire', Date.now() - startTime, success);
                        }
                    }
                }
            } catch (err: any) {
                socket.write(encodeError(err.message));
                if (err instanceof RespLimitError) {
                    buffer = Buffer.alloc(0);
                    socket.destroy();
                }
            }
        });

        socket.on('close', onDisconnect);
        socket.on('error', onDisconnect);
    }

    // ---- Command Execution ----

    private extractCommand(value: RESPValue): string[] | null {
        if (value.type === 'array' && Array.isArray(value.value)) {
            return value.value.map(v => String(v.value ?? ''));
        }
        return null;
    }

    /**
     * @param trusted the caller was authenticated elsewhere (the HTTP API)
     * @param wallet for a trusted caller: the wallet it acts as (its keyspace); omit for the operator
     */
    public async executeCommand(socket: any, args: string[], trusted: boolean = false, wallet?: string): Promise<void> {
        const cmd = args[0].toUpperCase();

        if (this.apiKey && !trusted && !UNPROTECTED_REDIS_COMMANDS.has(cmd) && !this.authenticatedSockets.has(socket)) {
            socket.write(encodeError('NOAUTH Authentication required.'));
            return;
        }
        const ks = new RedisKeyspace((trusted ? wallet : this.wallets.get(socket))?.toLowerCase());

        switch (cmd) {
            // ---- String commands ----
            case 'SET': {
                const key = ks.key('str', args[1]);
                const value = args[2] || '';
                await this.kvStore.put(key, Buffer.from(value));
                socket.write(encodeSimpleString('OK'));
                break;
            }

            case 'GET': {
                const key = ks.key('str', args[1]);
                const value = await this.kvStore.get(key);
                if (value) {
                    socket.write(encodeBulkString(value.toString('utf-8')));
                } else {
                    socket.write(encodeBulkString(null));
                }
                break;
            }

            case 'DEL': {
                let deleted = 0;
                for (let i = 1; i < args.length; i++) {
                    // Try all key types
                    const prefixes = ks.prefixes;
                    for (const prefix of prefixes) {
                        if (await this.kvStore.delete(prefix + args[i])) {
                            deleted++;
                            break;
                        }
                    }
                }
                socket.write(encodeInteger(deleted));
                break;
            }

            case 'MGET': {
                const results: Buffer[] = [];
                for (let i = 1; i < args.length; i++) {
                    const value = await this.kvStore.get(ks.key('str', args[i]));
                    results.push(encodeBulkString(value ? value.toString('utf-8') : null));
                }
                socket.write(encodeArray(results));
                break;
            }

            case 'MSET': {
                for (let i = 1; i < args.length; i += 2) {
                    await this.kvStore.put(ks.key('str', args[i]), Buffer.from(args[i + 1] || ''));
                }
                socket.write(encodeSimpleString('OK'));
                break;
            }

            case 'INCR': {
                const key = ks.key('str', args[1]);
                const current = await this.kvStore.get(key);
                const num = current ? parseInt(current.toString('utf-8'), 10) || 0 : 0;
                const newVal = num + 1;
                await this.kvStore.put(key, Buffer.from(String(newVal)));
                socket.write(encodeInteger(newVal));
                break;
            }

            case 'DECR': {
                const key = ks.key('str', args[1]);
                const current = await this.kvStore.get(key);
                const num = current ? parseInt(current.toString('utf-8'), 10) || 0 : 0;
                const newVal = num - 1;
                await this.kvStore.put(key, Buffer.from(String(newVal)));
                socket.write(encodeInteger(newVal));
                break;
            }

            case 'EXISTS': {
                let count = 0;
                for (let i = 1; i < args.length; i++) {
                    if (await this.kvStore.has(ks.key('str', args[i]))) count++;
                }
                socket.write(encodeInteger(count));
                break;
            }

            case 'SETNX': {
                const key = ks.key('str', args[1]);
                const existing = await this.kvStore.has(key);
                if (!existing) {
                    await this.kvStore.put(key, Buffer.from(args[2] || ''));
                    socket.write(encodeInteger(1));
                } else {
                    socket.write(encodeInteger(0));
                }
                break;
            }

            case 'APPEND': {
                const key = ks.key('str', args[1]);
                const current = await this.kvStore.get(key);
                const newVal = (current ? current.toString('utf-8') : '') + (args[2] || '');
                await this.kvStore.put(key, Buffer.from(newVal));
                socket.write(encodeInteger(Buffer.byteLength(newVal)));
                break;
            }

            case 'STRLEN': {
                const key = ks.key('str', args[1]);
                const value = await this.kvStore.get(key);
                socket.write(encodeInteger(value ? value.length : 0));
                break;
            }

            // ---- Hash commands → Document operations ----
            case 'HSET': {
                const collection = args[1];
                const fields: Record<string, unknown> = {};
                for (let i = 2; i < args.length; i += 2) {
                    fields[args[i]] = args[i + 1];
                }
                // Store as JSON document in KV
                const hashKey = ks.key('hash', collection);
                const existing = await this.kvStore.get(hashKey);
                const doc = existing ? JSON.parse(existing.toString('utf-8')) : {};
                Object.assign(doc, fields);
                await this.kvStore.put(hashKey, Buffer.from(JSON.stringify(doc)));
                socket.write(encodeInteger(Object.keys(fields).length));
                break;
            }

            case 'HGET': {
                const hashKey = ks.key('hash', args[1]);
                const value = await this.kvStore.get(hashKey);
                if (value) {
                    const doc = JSON.parse(value.toString('utf-8'));
                    const field = doc[args[2]];
                    socket.write(encodeBulkString(field !== undefined ? String(field) : null));
                } else {
                    socket.write(encodeBulkString(null));
                }
                break;
            }

            case 'HGETALL': {
                const hashKey = ks.key('hash', args[1]);
                const value = await this.kvStore.get(hashKey);
                if (value) {
                    const doc = JSON.parse(value.toString('utf-8'));
                    const results: Buffer[] = [];
                    for (const [k, v] of Object.entries(doc)) {
                        results.push(encodeBulkString(k));
                        results.push(encodeBulkString(String(v)));
                    }
                    socket.write(encodeArray(results));
                } else {
                    socket.write(encodeArray([]));
                }
                break;
            }

            case 'HDEL': {
                const hashKey = ks.key('hash', args[1]);
                const value = await this.kvStore.get(hashKey);
                let removed = 0;
                if (value) {
                    const doc = JSON.parse(value.toString('utf-8'));
                    for (let i = 2; i < args.length; i++) {
                        if (args[i] in doc) {
                            delete doc[args[i]];
                            removed++;
                        }
                    }
                    await this.kvStore.put(hashKey, Buffer.from(JSON.stringify(doc)));
                }
                socket.write(encodeInteger(removed));
                break;
            }

            case 'HKEYS': {
                const hashKey = ks.key('hash', args[1]);
                const value = await this.kvStore.get(hashKey);
                if (value) {
                    const doc = JSON.parse(value.toString('utf-8'));
                    const keys = Object.keys(doc).map(k => encodeBulkString(k));
                    socket.write(encodeArray(keys));
                } else {
                    socket.write(encodeArray([]));
                }
                break;
            }

            case 'HVALS': {
                const hashKey = ks.key('hash', args[1]);
                const value = await this.kvStore.get(hashKey);
                if (value) {
                    const doc = JSON.parse(value.toString('utf-8'));
                    const vals = Object.values(doc).map(v => encodeBulkString(String(v)));
                    socket.write(encodeArray(vals));
                } else {
                    socket.write(encodeArray([]));
                }
                break;
            }

            case 'HEXISTS': {
                const hashKey = ks.key('hash', args[1]);
                const value = await this.kvStore.get(hashKey);
                if (value) {
                    const doc = JSON.parse(value.toString('utf-8'));
                    socket.write(encodeInteger(args[2] in doc ? 1 : 0));
                } else {
                    socket.write(encodeInteger(0));
                }
                break;
            }

            case 'HLEN': {
                const hashKey = ks.key('hash', args[1]);
                const value = await this.kvStore.get(hashKey);
                if (value) {
                    const doc = JSON.parse(value.toString('utf-8'));
                    socket.write(encodeInteger(Object.keys(doc).length));
                } else {
                    socket.write(encodeInteger(0));
                }
                break;
            }

            case 'HMSET': {
                // HMSET key field value [field value ...]
                const hashKey = ks.key('hash', args[1]);
                const existing = await this.kvStore.get(hashKey);
                const doc = existing ? JSON.parse(existing.toString('utf-8')) : {};
                for (let i = 2; i < args.length; i += 2) {
                    doc[args[i]] = args[i + 1];
                }
                await this.kvStore.put(hashKey, Buffer.from(JSON.stringify(doc)));
                socket.write(encodeSimpleString('OK'));
                break;
            }

            case 'HMGET': {
                // HMGET key field [field ...]
                const hashKey = ks.key('hash', args[1]);
                const value = await this.kvStore.get(hashKey);
                const doc = value ? JSON.parse(value.toString('utf-8')) : {};
                const results: Buffer[] = [];
                for (let i = 2; i < args.length; i++) {
                    const field = doc[args[i]];
                    results.push(encodeBulkString(field !== undefined ? String(field) : null));
                }
                socket.write(encodeArray(results));
                break;
            }

            case 'RENAME': {
                // RENAME oldkey newkey
                const oldName = args[1];
                const newName = args[2];
                if (!oldName || !newName) {
                    socket.write(encodeError('wrong number of arguments for \'rename\' command'));
                    break;
                }

                const prefixes = ks.prefixes;
                let found = false;
                for (const prefix of prefixes) {
                    const val = await this.kvStore.get(prefix + oldName);
                    if (val) {
                        // I5: Clear any existing keys at destination across ALL type prefixes
                        // to prevent cross-type conflicts (matching Redis RENAME behavior)
                        for (const destPrefix of prefixes) {
                            try { await this.kvStore.delete(destPrefix + newName); } catch { /* ignore */ }
                        }
                        await this.kvStore.put(prefix + newName, val);
                        await this.kvStore.delete(prefix + oldName);
                        found = true;
                        break;
                    }
                }

                if (found) {
                    socket.write(encodeSimpleString('OK'));
                } else {
                    socket.write(encodeError('no such key'));
                }
                break;
            }

            // ---- List commands (backed by JSON arrays in KV) ----
            case 'LPUSH':
            case 'RPUSH': {
                const listKey = ks.key('list', args[1]);
                const existing = await this.kvStore.get(listKey);
                const list: string[] = existing ? JSON.parse(existing.toString('utf-8')) : [];
                for (let i = 2; i < args.length; i++) {
                    if (cmd === 'LPUSH') list.unshift(args[i]);
                    else list.push(args[i]);
                }
                await this.kvStore.put(listKey, Buffer.from(JSON.stringify(list)));
                socket.write(encodeInteger(list.length));
                break;
            }

            case 'LPOP':
            case 'RPOP': {
                const listKey = ks.key('list', args[1]);
                const existing = await this.kvStore.get(listKey);
                if (!existing) {
                    socket.write(encodeBulkString(null));
                    break;
                }
                const list: string[] = JSON.parse(existing.toString('utf-8'));
                const val = cmd === 'LPOP' ? list.shift() : list.pop();
                await this.kvStore.put(listKey, Buffer.from(JSON.stringify(list)));
                socket.write(encodeBulkString(val ?? null));
                break;
            }

            case 'LLEN': {
                const listKey = ks.key('list', args[1]);
                const existing = await this.kvStore.get(listKey);
                const list = existing ? JSON.parse(existing.toString('utf-8')) : [];
                socket.write(encodeInteger(list.length));
                break;
            }

            case 'LRANGE': {
                const listKey = ks.key('list', args[1]);
                const start = parseInt(args[2], 10) || 0;
                const stop = parseInt(args[3], 10) ?? -1;
                const existing = await this.kvStore.get(listKey);
                const list: string[] = existing ? JSON.parse(existing.toString('utf-8')) : [];
                const end = stop < 0 ? list.length + stop + 1 : stop + 1;
                const slice = list.slice(start, end);
                socket.write(encodeArray(slice.map(s => encodeBulkString(s))));
                break;
            }

            // ---- Set commands ----
            case 'SADD': {
                const setKey = ks.key('set', args[1]);
                const existing = await this.kvStore.get(setKey);
                const set: Set<string> = existing ? new Set(JSON.parse(existing.toString('utf-8'))) : new Set();
                let added = 0;
                for (let i = 2; i < args.length; i++) {
                    if (!set.has(args[i])) { set.add(args[i]); added++; }
                }
                await this.kvStore.put(setKey, Buffer.from(JSON.stringify([...set])));
                socket.write(encodeInteger(added));
                break;
            }

            case 'SMEMBERS': {
                const setKey = ks.key('set', args[1]);
                const existing = await this.kvStore.get(setKey);
                const members: string[] = existing ? JSON.parse(existing.toString('utf-8')) : [];
                socket.write(encodeArray(members.map(m => encodeBulkString(m))));
                break;
            }

            case 'SISMEMBER': {
                const setKey = ks.key('set', args[1]);
                const existing = await this.kvStore.get(setKey);
                const members: string[] = existing ? JSON.parse(existing.toString('utf-8')) : [];
                socket.write(encodeInteger(members.includes(args[2]) ? 1 : 0));
                break;
            }

            case 'SCARD': {
                const setKey = ks.key('set', args[1]);
                const existing = await this.kvStore.get(setKey);
                const members: string[] = existing ? JSON.parse(existing.toString('utf-8')) : [];
                socket.write(encodeInteger(members.length));
                break;
            }

            case 'SREM': {
                const setKey = ks.key('set', args[1]);
                const existing = await this.kvStore.get(setKey);
                const members: string[] = existing ? JSON.parse(existing.toString('utf-8')) : [];
                let removed = 0;
                for (let i = 2; i < args.length; i++) {
                    const idx = members.indexOf(args[i]);
                    if (idx !== -1) { members.splice(idx, 1); removed++; }
                }
                await this.kvStore.put(setKey, Buffer.from(JSON.stringify(members)));
                socket.write(encodeInteger(removed));
                break;
            }

            // ---- Pub/Sub commands ----
            case 'SUBSCRIBE': {
                for (let i = 1; i < args.length; i++) {
                    const name = args[i];
                    const channel = ks.channel(name); // a wallet's channels are its own
                    if (!this.subscribedClients.has(channel)) {
                        this.subscribedClients.set(channel, new Set());
                    }
                    this.subscribedClients.get(channel)!.add(socket);

                    // If we have a message broker, subscribe on-chain
                    if (this.messageBroker) {
                        this.messageBroker.subscribe(channel, (message: string) => {
                            this.pushMessage(socket, 'message', name, message);
                        });
                    }

                    // Send subscription confirmation
                    socket.write(encodeArray([
                        encodeBulkString('subscribe'),
                        encodeBulkString(name),
                        encodeInteger(this.subscribedClients.get(channel)!.size),
                    ]));
                }
                break;
            }

            case 'UNSUBSCRIBE': {
                const named: [string, string][] = args.length > 1
                    ? args.slice(1).map((name): [string, string] => [name, ks.channel(name)])
                    : [...this.subscribedClients].filter(([, subs]) => subs.has(socket))
                        .map(([channel]): [string, string] => [ks.wallet ? channel.substring(ks.wallet.length + 1) : channel, channel]);
                for (const [name, channel] of named) {
                    this.subscribedClients.get(channel)?.delete(socket);
                    if (this.messageBroker) {
                        this.messageBroker.unsubscribe(channel);
                    }
                    socket.write(encodeArray([
                        encodeBulkString('unsubscribe'),
                        encodeBulkString(name),
                        encodeInteger(0),
                    ]));
                }
                break;
            }

            case 'PUBLISH': {
                const name = args[1];
                const channel = ks.channel(name);
                const message = args[2];
                let receivers = 0;

                // Local subscribers
                const subs = this.subscribedClients.get(channel);
                if (subs) {
                    for (const sub of subs) {
                        if (sub !== socket && !sub.destroyed) {
                            this.pushMessage(sub, 'message', name, message);
                            receivers++;
                        }
                    }
                }

                // On-chain publish via MessageBroker
                if (this.messageBroker) {
                    try {
                        const onChainReceivers = await this.messageBroker.publish(channel, message);
                        receivers += onChainReceivers;
                    } catch {
                        // On-chain publish failed — still count local receivers
                    }
                }

                socket.write(encodeInteger(receivers));
                break;
            }

            case 'PSUBSCRIBE': {
                // Pattern-based subscribe
                const pattern = args[1];
                const key = `pattern:${ks.channel(pattern)}`;
                if (!this.subscribedClients.has(key)) {
                    this.subscribedClients.set(key, new Set());
                }
                this.subscribedClients.get(key)!.add(socket);
                socket.write(encodeArray([
                    encodeBulkString('psubscribe'),
                    encodeBulkString(pattern),
                    encodeInteger(1),
                ]));
                break;
            }

            // ---- Server commands ----
            case 'PING': {
                socket.write(args[1] ? encodeBulkString(args[1]) : encodeSimpleString('PONG'));
                break;
            }

            case 'INFO': {
                const info = [
                    `# Server`,
                    `redis_version:7.0.0-PlugPort`,
                    `tcp_port:${this.port}`,
                    `connected_clients:${this.activeConnections.size}`,
                    `# Keyspace`,
                    `db0:keys=${await this.countKeys(ks)},expires=0`,
                ].join('\r\n');
                socket.write(encodeBulkString(info));
                break;
            }

            case 'DBSIZE': {
                socket.write(encodeInteger(await this.countKeys(ks)));
                break;
            }

            case 'FLUSHDB':
            case 'FLUSHALL': {
                // Only this keyspace's Redis keys. It used to call kvStore.clear(),
                // which deleted every key in the store: all collections, every customer's.
                for (const prefix of ks.prefixes) await this.deleteByPrefix(prefix);
                socket.write(encodeSimpleString('OK'));
                break;
            }

            case 'SELECT': {
                // Database selection — acknowledge (PlugPort uses a single namespace)
                socket.write(encodeSimpleString('OK'));
                break;
            }

            case 'AUTH': {
                // AUTH <password> is the master key. AUTH <0xWallet[:N]> <api key> logs
                // in as that wallet, with its own keyspace — only over TLS, since the
                // key itself crosses the wire.
                const [user, password] = args.length >= 3 ? [args[1], args[2]] : ['default', args[1] || ''];
                if (!this.apiKey) {
                    // No API key configured — nothing to check against (dev mode)
                    socket.write(encodeSimpleString('OK'));
                } else if (isWalletLogin(user)) {
                    if (!isSecure(socket)) {
                        socket.write(encodeError('ERR wallet logins need TLS, since the API key is sent to the server: connect with rediss://'));
                        break;
                    }
                    const resolved = await resolveScramCredentials(user, this.apiKey);
                    if (resolved.ok && verifyScramPassword(resolved.credentials, password)) {
                        this.authenticatedSockets.add(socket);
                        if (resolved.credentials.wallet) this.wallets.set(socket, resolved.credentials.wallet);
                        else this.wallets.delete(socket);
                        socket.write(encodeSimpleString('OK'));
                    } else {
                        socket.write(encodeError(resolved.ok ? 'WRONGPASS invalid username-password pair or user is disabled.' : `WRONGPASS ${resolved.errmsg}`));
                    }
                } else if (safeCompare(password, this.apiKey)) {
                    this.authenticatedSockets.add(socket);
                    this.wallets.delete(socket);
                    socket.write(encodeSimpleString('OK'));
                } else {
                    socket.write(encodeError('WRONGPASS invalid username-password pair or user is disabled.'));
                }
                break;
            }

            case 'KEYS': {
                const pattern = args[1] || '*';
                const root = ks.prefix('str');
                const prefix = pattern === '*' ? root : ks.key('str', pattern.replace('*', ''));
                const entries = await this.kvStore.scan({ prefix, limit: 1000 });
                const keys = entries.map(e => encodeBulkString(e.key.substring(root.length)));
                socket.write(encodeArray(keys));
                break;
            }

            case 'TYPE': {
                const baseKey = args[1];
                if (await this.kvStore.has(ks.key('str', baseKey))) socket.write(encodeSimpleString('string'));
                else if (await this.kvStore.has(ks.key('hash', baseKey))) socket.write(encodeSimpleString('hash'));
                else if (await this.kvStore.has(ks.key('list', baseKey))) socket.write(encodeSimpleString('list'));
                else if (await this.kvStore.has(ks.key('set', baseKey))) socket.write(encodeSimpleString('set'));
                else if (await this.kvStore.has(ks.key('zset', baseKey))) socket.write(encodeSimpleString('zset'));
                else socket.write(encodeSimpleString('none'));
                break;
            }

            case 'TTL':
            case 'PTTL': {
                // TTL not supported on-chain — return -1 (no expiry)
                socket.write(encodeInteger(-1));
                break;
            }

            case 'EXPIRE':
            case 'PEXPIRE':
            case 'PERSIST': {
                // Expiry not supported — acknowledge silently
                socket.write(encodeInteger(1));
                break;
            }

            case 'COMMAND': {
                // COMMAND DOCS / COMMAND COUNT — minimal response
                if (args[1]?.toUpperCase() === 'DOCS') {
                    socket.write(encodeArray([]));
                } else {
                    socket.write(encodeInteger(50)); // Approximate command count
                }
                break;
            }

            case 'CLIENT': {
                // CLIENT SETNAME, CLIENT INFO, etc.
                socket.write(encodeSimpleString('OK'));
                break;
            }

            case 'CONFIG': {
                // CONFIG GET/SET — minimal response
                if (args[1]?.toUpperCase() === 'GET') {
                    socket.write(encodeArray([
                        encodeBulkString(args[2] || ''),
                        encodeBulkString(''),
                    ]));
                } else {
                    socket.write(encodeSimpleString('OK'));
                }
                break;
            }

            case 'QUIT': {
                socket.write(encodeSimpleString('OK'));
                socket.end();
                break;
            }

            case 'ECHO': {
                socket.write(encodeBulkString(args[1] || ''));
                break;
            }

            default: {
                socket.write(encodeError(`unknown command '${cmd}'`));
            }
        }
    }

    // ---- Keyspace Helpers ----

    private async countKeys(ks: RedisKeyspace): Promise<number> {
        let count = 0;
        for (const prefix of ks.prefixes) count += await this.kvStore.count(prefix);
        return count;
    }

    private async deleteByPrefix(prefix: string): Promise<void> {
        for (;;) {
            const keys = (await this.kvStore.scan({ prefix, limit: 500 })).map((e) => e.key);
            if (keys.length === 0) return;
            // Batched where the store supports it: on chain, one transaction per batch, not per key.
            if (this.kvStore.batchWrite) await this.kvStore.batchWrite([], keys);
            else for (const key of keys) await this.kvStore.delete(key);
        }
    }

    // ---- Pub/Sub Helpers ----

    private pushMessage(socket: net.Socket, type: string, channel: string, message: string): void {
        if (socket.destroyed) return;
        socket.write(encodeArray([
            encodeBulkString(type),
            encodeBulkString(channel),
            encodeBulkString(message),
        ]));
    }

    private removeSubscriptions(socket: net.Socket): void {
        for (const [, subs] of this.subscribedClients) {
            subs.delete(socket);
        }
    }
}
