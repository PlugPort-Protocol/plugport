// The wire ports are open to the internet. On 2026-09-27 the server died of a heap
// OOM with only wire connections active: MongoDB parsed messages of up to 48 MB
// before authentication (BSON expands ~6.5x into objects), and PostgreSQL, MySQL
// and Redis buffered input of any size. These tests drive each server over a real
// socket and check that an unauthenticated client can no longer make it hold more
// than a handshake's worth of data.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { BSON } from 'bson';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { MetricsCollector } from '../metrics.js';
import { createWireServer } from '../wire-server.js';
import { PGServer } from '../protocols/pg-server.js';
import { MySQLServer } from '../protocols/mysql-server.js';
import { RedisServer, parseRESP, RespLimitError } from '../protocols/redis-server.js';
import { PRE_AUTH_MAX_BYTES, closeUnlessAuthenticatedWithin } from '../protocols/connection-limits.js';

const API_KEY = 'test-api-key';

async function freePort(): Promise<number> {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const { port } = s.address() as net.AddressInfo;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
}

/** Connect, run `send`, and resolve with whatever came back once the server closes the socket (or reject after `ms`). */
function untilClosed(port: number, send: (socket: net.Socket) => void, ms = 3000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        const received: Buffer[] = [];
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('server kept the connection open')); }, ms);
        socket.on('data', (d) => received.push(d));
        socket.on('error', () => { /* a reset is also a close */ });
        socket.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(received)); });
        socket.on('connect', () => send(socket));
    });
}

/** Connect, send, and resolve with the first reply (the connection is expected to stay open). */
function firstReply(port: number, payload: Buffer, ms = 3000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('no reply')); }, ms);
        socket.once('data', (d) => { clearTimeout(timer); socket.destroy(); resolve(d); });
        socket.on('error', reject);
    });
}

const OVERSIZED = PRE_AUTH_MAX_BYTES * 2;

describe('MongoDB wire server limits', () => {
    let server: net.Server;
    let port: number;

    beforeAll(async () => {
        server = createWireServer({ port: 0, host: '127.0.0.1', apiKey: API_KEY, store: new DocumentStore(new InMemoryKVStore()), metrics: new MetricsCollector() });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        port = (server.address() as net.AddressInfo).port;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    const opMsg = (doc: Record<string, unknown>): Buffer => {
        const body = BSON.serialize(doc);
        const header = Buffer.alloc(16);
        const total = 16 + 4 + 1 + body.length;
        header.writeInt32LE(total, 0);
        header.writeInt32LE(1, 4);
        header.writeInt32LE(0, 8);
        header.writeInt32LE(2013, 12); // OP_MSG
        return Buffer.concat([header, Buffer.alloc(4), Buffer.from([0]), Buffer.from(body)]);
    };

    it('still answers a normal unauthenticated hello', async () => {
        const reply = await firstReply(port, opMsg({ hello: 1, $db: 'admin' }));
        expect(reply.length).toBeGreaterThan(16);
    });

    it('refuses an unauthenticated message larger than a handshake — before parsing it', async () => {
        // Header claims 1 MB: the old limit was 48 MB, so this used to be buffered and parsed.
        const header = Buffer.alloc(16);
        header.writeInt32LE(1024 * 1024, 0);
        header.writeInt32LE(2013, 12);
        const reply = await untilClosed(port, (s) => s.write(header));
        expect(reply.toString('latin1')).toContain('exceeds maximum allowed size of 65536');
    });

    it('advertises the smaller authenticated limit to drivers', async () => {
        const reply = await firstReply(port, opMsg({ hello: 1, $db: 'admin' }));
        const doc = BSON.deserialize(reply.subarray(21));
        expect(doc.maxMessageSizeBytes).toBe(8 * 1024 * 1024);
    });
});

describe('PostgreSQL server limits', () => {
    let server: PGServer;
    let port: number;

    beforeAll(async () => {
        port = await freePort();
        server = new PGServer({ store: new DocumentStore(new InMemoryKVStore()), port, host: '127.0.0.1', apiKey: API_KEY } as any);
        await server.start();
    });
    afterAll(() => server.stop());

    it('closes a connection whose startup packet claims more than PostgreSQL allows', async () => {
        const startup = Buffer.alloc(8);
        startup.writeInt32BE(1_000_000, 0);
        startup.writeInt32BE(196608, 4);
        await untilClosed(port, (s) => s.write(startup));
    });

    it('closes a connection that streams data without authenticating', async () => {
        await untilClosed(port, (s) => s.write(Buffer.alloc(OVERSIZED, 0x41)));
    });

    it('rejects a message whose length field is negative (used to re-read the same bytes forever)', async () => {
        const startup = Buffer.alloc(8);
        startup.writeInt32BE(8, 0);
        startup.writeInt32BE(196608, 4);
        const bad = Buffer.alloc(5);
        bad[0] = 0x70; // 'p' (password message)
        bad.writeInt32BE(-1, 1);
        // Sent after the server's password request, as a real client would.
        await untilClosed(port, (s) => {
            s.once('data', () => s.write(bad));
            s.write(startup);
        });
    });
});

describe('MySQL server limits', () => {
    let server: MySQLServer;
    let port: number;

    beforeAll(async () => {
        port = await freePort();
        server = new MySQLServer({ store: new DocumentStore(new InMemoryKVStore()), port, host: '127.0.0.1', apiKey: API_KEY } as any);
        await server.start();
    });
    afterAll(() => server.stop());

    it('refuses a pre-authentication packet larger than a handshake', async () => {
        const header = Buffer.from([0xff, 0xff, 0x0f, 1]); // claims ~1 MB
        const reply = await untilClosed(port, (s) => s.write(header));
        expect(reply.toString('latin1')).toContain('exceeds the maximum of 65536');
    });
});

describe('Redis server limits', () => {
    let server: RedisServer;
    let port: number;

    beforeAll(async () => {
        port = await freePort();
        const kvStore = new InMemoryKVStore();
        server = new RedisServer({ store: new DocumentStore(kvStore), kvStore, port, host: '127.0.0.1', apiKey: API_KEY } as any);
        await server.start();
    });
    afterAll(() => server.stop());

    it('still answers PING before authentication', async () => {
        expect((await firstReply(port, Buffer.from('*1\r\n$4\r\nPING\r\n'))).toString()).toBe('+PONG\r\n');
    });

    it('closes an unauthenticated client that sends more than a handshake', async () => {
        // An inline command with no line ending: the old server buffered it without limit.
        await untilClosed(port, (s) => s.write(Buffer.alloc(OVERSIZED, 0x61)));
    });

    it('closes a client announcing an absurd array size', async () => {
        const reply = await untilClosed(port, (s) => s.write('*999999999\r\n'));
        expect(reply.toString()).toContain('invalid multibulk length');
    });
});

describe('parseRESP limits', () => {
    const limits = { maxBulkBytes: 1024, maxArrayElements: 10 };

    it('rejects nested arrays, oversized bulks and arrays only when limits are given', () => {
        const nested = Buffer.from('*1\r\n*1\r\n$1\r\na\r\n');
        expect(() => parseRESP(nested, limits)).toThrow(RespLimitError);
        expect(parseRESP(nested)?.value.type).toBe('array'); // server replies (SCAN, …) may nest

        expect(() => parseRESP(Buffer.from('$5000\r\n'), limits)).toThrow(/bulk length/);
        expect(() => parseRESP(Buffer.from('*11\r\n'), limits)).toThrow(/multibulk length/);
        expect(() => parseRESP(Buffer.from('$-5\r\n'), limits)).toThrow(/bulk length/);
    });

    it('parses an ordinary command under the limits', () => {
        const parsed = parseRESP(Buffer.from('*2\r\n$3\r\nGET\r\n$1\r\nk\r\n'), limits);
        expect(parsed?.bytesConsumed).toBe(20);
    });
});

describe('closeUnlessAuthenticatedWithin', () => {
    const fakeSocket = () => Object.assign(new EventEmitter(), { destroy: vi.fn() }) as unknown as net.Socket & { destroy: ReturnType<typeof vi.fn> };

    it('closes a connection that has not authenticated in time, and leaves an authenticated one alone', () => {
        vi.useFakeTimers();
        try {
            const idle = fakeSocket();
            const loggedIn = fakeSocket();
            closeUnlessAuthenticatedWithin(idle, () => false, 1000);
            closeUnlessAuthenticatedWithin(loggedIn, () => true, 1000);
            vi.advanceTimersByTime(1001);
            expect(idle.destroy).toHaveBeenCalled();
            expect(loggedIn.destroy).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
