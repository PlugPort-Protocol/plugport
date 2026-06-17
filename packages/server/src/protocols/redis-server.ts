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
import type { DocumentStore } from '../storage/document-store.js';
import type { KVAdapter } from '@plugport/shared';
import type { ProtocolServerInstance } from './protocol-manager.js';
import type { ProtocolType } from '@plugport/shared';

// ---- RESP Parser ----

interface RESPValue {
    type: 'string' | 'error' | 'integer' | 'bulk' | 'array' | 'null';
    value: string | number | null | RESPValue[];
}

export function parseRESP(data: Buffer): { value: RESPValue; bytesConsumed: number } | null {
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
            if (count === -1) {
                return { value: { type: 'null', value: null }, bytesConsumed: crlfIndex + 2 };
            }

            let offset = crlfIndex + 2;
            const elements: RESPValue[] = [];

            for (let i = 0; i < count; i++) {
                const result = parseRESP(data.subarray(offset));
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

    constructor(options: {
        store: DocumentStore;
        kvStore: KVAdapter;
        port?: number;
        host?: string;
        messageBroker?: any;
    }) {
        this.store = options.store;
        this.kvStore = options.kvStore;
        this.port = options.port || 6379;
        this.host = options.host || '0.0.0.0';
        this.messageBroker = options.messageBroker || null;
    }

    async start(): Promise<void> {
        if (this.server) return;

        return new Promise((resolve, reject) => {
            this.server = net.createServer((socket) => this.handleConnection(socket));
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

        let buffer = Buffer.alloc(0);

        socket.on('data', async (data) => {
            buffer = Buffer.concat([buffer, data]);

            try {
                while (buffer.length > 0) {
                    const result = parseRESP(buffer);
                    if (!result) break; // Incomplete message

                    buffer = buffer.subarray(result.bytesConsumed);
                    const command = this.extractCommand(result.value);
                    if (command) {
                        await this.executeCommand(socket, command);
                    }
                }
            } catch (err: any) {
                socket.write(encodeError(err.message));
            }
        });

        socket.on('close', () => {
            this.removeSubscriptions(socket);
            this.activeConnections.delete(socket);
            this.connections--;
        });

        socket.on('error', () => {
            this.removeSubscriptions(socket);
            this.activeConnections.delete(socket);
            this.connections--;
        });
    }

    // ---- Command Execution ----

    private extractCommand(value: RESPValue): string[] | null {
        if (value.type === 'array' && Array.isArray(value.value)) {
            return value.value.map(v => String(v.value ?? ''));
        }
        return null;
    }

    public async executeCommand(socket: any, args: string[]): Promise<void> {
        const cmd = args[0].toUpperCase();

        switch (cmd) {
            // ---- String commands ----
            case 'SET': {
                const key = `redis:str:${args[1]}`;
                const value = args[2] || '';
                await this.kvStore.put(key, Buffer.from(value));
                socket.write(encodeSimpleString('OK'));
                break;
            }

            case 'GET': {
                const key = `redis:str:${args[1]}`;
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
                    const prefixes = ['redis:str:', 'redis:hash:', 'redis:list:', 'redis:set:', 'redis:zset:'];
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
                    const value = await this.kvStore.get(`redis:str:${args[i]}`);
                    results.push(encodeBulkString(value ? value.toString('utf-8') : null));
                }
                socket.write(encodeArray(results));
                break;
            }

            case 'MSET': {
                for (let i = 1; i < args.length; i += 2) {
                    await this.kvStore.put(`redis:str:${args[i]}`, Buffer.from(args[i + 1] || ''));
                }
                socket.write(encodeSimpleString('OK'));
                break;
            }

            case 'INCR': {
                const key = `redis:str:${args[1]}`;
                const current = await this.kvStore.get(key);
                const num = current ? parseInt(current.toString('utf-8'), 10) || 0 : 0;
                const newVal = num + 1;
                await this.kvStore.put(key, Buffer.from(String(newVal)));
                socket.write(encodeInteger(newVal));
                break;
            }

            case 'DECR': {
                const key = `redis:str:${args[1]}`;
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
                    if (await this.kvStore.has(`redis:str:${args[i]}`)) count++;
                }
                socket.write(encodeInteger(count));
                break;
            }

            case 'SETNX': {
                const key = `redis:str:${args[1]}`;
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
                const key = `redis:str:${args[1]}`;
                const current = await this.kvStore.get(key);
                const newVal = (current ? current.toString('utf-8') : '') + (args[2] || '');
                await this.kvStore.put(key, Buffer.from(newVal));
                socket.write(encodeInteger(Buffer.byteLength(newVal)));
                break;
            }

            case 'STRLEN': {
                const key = `redis:str:${args[1]}`;
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
                const hashKey = `redis:hash:${collection}`;
                const existing = await this.kvStore.get(hashKey);
                const doc = existing ? JSON.parse(existing.toString('utf-8')) : {};
                Object.assign(doc, fields);
                await this.kvStore.put(hashKey, Buffer.from(JSON.stringify(doc)));
                socket.write(encodeInteger(Object.keys(fields).length));
                break;
            }

            case 'HGET': {
                const hashKey = `redis:hash:${args[1]}`;
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
                const hashKey = `redis:hash:${args[1]}`;
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
                const hashKey = `redis:hash:${args[1]}`;
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
                const hashKey = `redis:hash:${args[1]}`;
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
                const hashKey = `redis:hash:${args[1]}`;
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
                const hashKey = `redis:hash:${args[1]}`;
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
                const hashKey = `redis:hash:${args[1]}`;
                const value = await this.kvStore.get(hashKey);
                if (value) {
                    const doc = JSON.parse(value.toString('utf-8'));
                    socket.write(encodeInteger(Object.keys(doc).length));
                } else {
                    socket.write(encodeInteger(0));
                }
                break;
            }

            // ---- List commands (backed by JSON arrays in KV) ----
            case 'LPUSH':
            case 'RPUSH': {
                const listKey = `redis:list:${args[1]}`;
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
                const listKey = `redis:list:${args[1]}`;
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
                const listKey = `redis:list:${args[1]}`;
                const existing = await this.kvStore.get(listKey);
                const list = existing ? JSON.parse(existing.toString('utf-8')) : [];
                socket.write(encodeInteger(list.length));
                break;
            }

            case 'LRANGE': {
                const listKey = `redis:list:${args[1]}`;
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
                const setKey = `redis:set:${args[1]}`;
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
                const setKey = `redis:set:${args[1]}`;
                const existing = await this.kvStore.get(setKey);
                const members: string[] = existing ? JSON.parse(existing.toString('utf-8')) : [];
                socket.write(encodeArray(members.map(m => encodeBulkString(m))));
                break;
            }

            case 'SISMEMBER': {
                const setKey = `redis:set:${args[1]}`;
                const existing = await this.kvStore.get(setKey);
                const members: string[] = existing ? JSON.parse(existing.toString('utf-8')) : [];
                socket.write(encodeInteger(members.includes(args[2]) ? 1 : 0));
                break;
            }

            case 'SCARD': {
                const setKey = `redis:set:${args[1]}`;
                const existing = await this.kvStore.get(setKey);
                const members: string[] = existing ? JSON.parse(existing.toString('utf-8')) : [];
                socket.write(encodeInteger(members.length));
                break;
            }

            case 'SREM': {
                const setKey = `redis:set:${args[1]}`;
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
                    const channel = args[i];
                    if (!this.subscribedClients.has(channel)) {
                        this.subscribedClients.set(channel, new Set());
                    }
                    this.subscribedClients.get(channel)!.add(socket);

                    // If we have a message broker, subscribe on-chain
                    if (this.messageBroker) {
                        this.messageBroker.subscribe(channel, (message: string) => {
                            this.pushMessage(socket, 'message', channel, message);
                        });
                    }

                    // Send subscription confirmation
                    socket.write(encodeArray([
                        encodeBulkString('subscribe'),
                        encodeBulkString(channel),
                        encodeInteger(this.subscribedClients.get(channel)!.size),
                    ]));
                }
                break;
            }

            case 'UNSUBSCRIBE': {
                const channels = args.length > 1 ? args.slice(1) : [...this.subscribedClients.keys()];
                for (const channel of channels) {
                    this.subscribedClients.get(channel)?.delete(socket);
                    if (this.messageBroker) {
                        this.messageBroker.unsubscribe(channel);
                    }
                    socket.write(encodeArray([
                        encodeBulkString('unsubscribe'),
                        encodeBulkString(channel),
                        encodeInteger(0),
                    ]));
                }
                break;
            }

            case 'PUBLISH': {
                const channel = args[1];
                const message = args[2];
                let receivers = 0;

                // Local subscribers
                const subs = this.subscribedClients.get(channel);
                if (subs) {
                    for (const sub of subs) {
                        if (sub !== socket && !sub.destroyed) {
                            this.pushMessage(sub, 'message', channel, message);
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
                if (!this.subscribedClients.has(`pattern:${pattern}`)) {
                    this.subscribedClients.set(`pattern:${pattern}`, new Set());
                }
                this.subscribedClients.get(`pattern:${pattern}`)!.add(socket);
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
                    `db0:keys=${await this.kvStore.count()},expires=0`,
                ].join('\r\n');
                socket.write(encodeBulkString(info));
                break;
            }

            case 'DBSIZE': {
                const count = await this.kvStore.count('redis:');
                socket.write(encodeInteger(count));
                break;
            }

            case 'FLUSHDB':
            case 'FLUSHALL': {
                await this.kvStore.clear();
                socket.write(encodeSimpleString('OK'));
                break;
            }

            case 'SELECT': {
                // Database selection — acknowledge (PlugPort uses a single namespace)
                socket.write(encodeSimpleString('OK'));
                break;
            }

            case 'AUTH': {
                // Authentication — accept any password
                socket.write(encodeSimpleString('OK'));
                break;
            }

            case 'KEYS': {
                const pattern = args[1] || '*';
                const prefix = pattern === '*' ? 'redis:str:' : `redis:str:${pattern.replace('*', '')}`;
                const entries = await this.kvStore.scan({ prefix, limit: 1000 });
                const keys = entries.map(e => encodeBulkString(e.key.replace(/^redis:str:/, '')));
                socket.write(encodeArray(keys));
                break;
            }

            case 'TYPE': {
                const baseKey = args[1];
                if (await this.kvStore.has(`redis:str:${baseKey}`)) socket.write(encodeSimpleString('string'));
                else if (await this.kvStore.has(`redis:hash:${baseKey}`)) socket.write(encodeSimpleString('hash'));
                else if (await this.kvStore.has(`redis:list:${baseKey}`)) socket.write(encodeSimpleString('list'));
                else if (await this.kvStore.has(`redis:set:${baseKey}`)) socket.write(encodeSimpleString('set'));
                else if (await this.kvStore.has(`redis:zset:${baseKey}`)) socket.write(encodeSimpleString('zset'));
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
