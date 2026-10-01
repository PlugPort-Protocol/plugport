// Per-customer logins on MySQL and Redis (roadmap item 3): a wallet logs in
// with one of its API keys — checked against the same on-chain verifier as
// MongoDB and PostgreSQL — only over TLS, since these logins send the key
// itself. Redis gives each wallet its own keyspace and channels. The master
// key keeps working as before.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { verifierFor } from './scram-client.js';
import { TEST_CERT, TEST_KEY } from './tls-fixtures.js';

const authContract = { isReadable: true, getActiveKeys: vi.fn(), getVerifier: vi.fn() };
vi.mock('../auth/auth-contract.js', async () => {
    const actual = await vi.importActual<typeof import('../auth/auth-contract.js')>('../auth/auth-contract.js');
    return { ...actual, getAuthContract: () => authContract };
});

const { MySQLServer } = await import('../protocols/mysql-server.js');
const { RedisServer, parseRESP } = await import('../protocols/redis-server.js');
const { WireTls } = await import('../protocols/wire-tls.js');
const { DocumentStore } = await import('../storage/document-store.js');
const { InMemoryKVStore } = await import('../storage/kv-adapter.js');
const { PrivacyManager } = await import('../storage/privacy-manager.js');
const { CollectionClaims } = await import('../storage/collection-claims.js');
const { CollectionAccess } = await import('../storage/collection-access.js');
const { Namespaces } = await import('../storage/namespaces.js');

const MASTER = 'master-api-key';
const ALICE = '0xa11ce00000000000000000000000000000000001';
const BOB = '0xb0b0000000000000000000000000000000000002';
const KEYS: Record<string, string> = { [ALICE]: 'pp_test_alice_key_0123456789abcdef', [BOB]: 'pp_test_bob_key_0123456789abcdef00' };
const CA = fs.readFileSync(TEST_CERT);
const PORT = 48000 + Math.floor(Math.random() * 900);
const sockets: net.Socket[] = [];
const stops: (() => Promise<void>)[] = [];
afterAll(async () => {
    sockets.forEach((s) => s.destroy());
    for (const stop of stops) await stop();
});
beforeEach(() => {
    authContract.getActiveKeys.mockResolvedValue([{ keyIndex: 0 }]);
    const verifiers = Object.fromEntries(Object.entries(KEYS).map(([w, k]) => [w, verifierFor(k)]));
    authContract.getVerifier.mockImplementation(async (wallet: string) => verifiers[wallet.toLowerCase()]);
});

/** Reads a byte stream as discrete frames. */
class Reader {
    private buf = Buffer.alloc(0);
    private waiters: (() => void)[] = [];
    constructor(public socket: net.Socket) { this.attach(socket); }
    attach(socket: net.Socket) {
        this.socket = socket;
        socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.waiters.splice(0).forEach((w) => w()); });
    }
    /** Wait until `take` can cut a frame off the buffer. */
    async frame<T>(take: (buf: Buffer) => { value: T; used: number } | null): Promise<T> {
        for (;;) {
            const got = take(this.buf);
            if (got) { this.buf = this.buf.subarray(got.used); return got.value; }
            await new Promise<void>((r) => this.waiters.push(r));
        }
    }
}

function connect(port: number): Promise<net.Socket> {
    return new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => resolve(s));
        s.on('error', () => {}); // resets at teardown must not crash the test worker
        sockets.push(s);
    });
}

function startTls(socket: net.Socket): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
        const s = tls.connect({ socket, ca: CA, servername: 'localhost' }, () => resolve(s));
        s.once('error', reject);
        s.on('error', () => {});
        sockets.push(s);
    });
}

// ---- MySQL ----

const mysqlPacket = (buf: Buffer) => {
    if (buf.length < 4) return null;
    const len = buf[0] | (buf[1] << 8) | (buf[2] << 16);
    if (buf.length < 4 + len) return null;
    return { value: { seq: buf[3], payload: buf.subarray(4, 4 + len) }, used: 4 + len };
};

function writeMysql(socket: net.Socket, seq: number, payload: Buffer) {
    const head = Buffer.from([payload.length & 0xff, (payload.length >> 8) & 0xff, (payload.length >> 16) & 0xff, seq]);
    socket.write(Buffer.concat([head, payload]));
}

const CLIENT_FLAGS = 0x0200 | 0x8000 | 0x80000 | 0x0008; // PROTOCOL_41 | SECURE_CONNECTION | PLUGIN_AUTH | CONNECT_WITH_DB

function handshakeResponse(flags: number, user: string, auth: Buffer, plugin: string) {
    const head = Buffer.alloc(32);
    head.writeUInt32LE(flags, 0);
    head.writeUInt32LE(16 * 1024 * 1024, 4);
    head[8] = 45;
    return Buffer.concat([head, Buffer.from(`${user}\0`), Buffer.from([auth.length]), auth, Buffer.from('test\0'), Buffer.from(`${plugin}\0`)]);
}

/** Log in to MySQL; resolves to the final OK/ERR payload and a reader on the (maybe TLS) connection. */
async function mysqlLogin(opts: { user: string; password: string; tls: boolean }) {
    const raw = await connect(PORT);
    const reader = new Reader(raw);
    const greeting = (await reader.frame(mysqlPacket)).payload;
    const versionEnd = greeting.indexOf(0, 1);
    const challenge = Buffer.concat([greeting.subarray(versionEnd + 5, versionEnd + 13), greeting.subarray(versionEnd + 13 + 1 + 2 + 1 + 2 + 2 + 1 + 10, versionEnd + 13 + 1 + 2 + 1 + 2 + 2 + 1 + 10 + 12)]);
    const sslOffered = (greeting.readUInt16LE(versionEnd + 14) & 0x0800) !== 0;
    let socket: net.Socket = raw;
    let seq = 1;
    if (opts.tls) {
        expect(sslOffered).toBe(true);
        const sslRequest = Buffer.alloc(32);
        sslRequest.writeUInt32LE(CLIENT_FLAGS | 0x0800, 0);
        sslRequest.writeUInt32LE(16 * 1024 * 1024, 4);
        sslRequest[8] = 45;
        writeMysql(raw, seq++, sslRequest);
        raw.removeAllListeners('data');
        socket = await startTls(raw);
        reader.attach(socket);
    }
    const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest();
    const native = (() => { const p1 = sha1(Buffer.from(opts.password)); const p2 = sha1(Buffer.concat([challenge, sha1(p1)])); return Buffer.from(p1.map((b, i) => b ^ p2[i])); })();
    writeMysql(socket, seq++, handshakeResponse(CLIENT_FLAGS | (opts.tls ? 0x0800 : 0), opts.user, native, 'mysql_native_password'));
    let reply = await reader.frame(mysqlPacket);
    if (reply.payload[0] === 0xfe) {
        // AuthSwitchRequest → caching_sha2_password: scramble, then the key itself.
        expect(reply.payload.subarray(1, 22).toString()).toBe('caching_sha2_password');
        writeMysql(socket, reply.seq + 1, crypto.randomBytes(32));
        reply = await reader.frame(mysqlPacket);
        expect([...reply.payload]).toEqual([0x01, 0x04]); // perform full authentication
        writeMysql(socket, reply.seq + 1, Buffer.from(`${opts.password}\0`));
        reply = await reader.frame(mysqlPacket);
    }
    const query = async (sql: string) => {
        writeMysql(socket, 0, Buffer.concat([Buffer.from([0x03]), Buffer.from(sql)]));
        const packets: Buffer[] = [];
        for (;;) {
            const p = (await reader.frame(mysqlPacket)).payload;
            packets.push(p);
            if (packets.length === 1 && (p[0] === 0x00 || p[0] === 0xff)) break; // OK / ERR
            if (p[0] === 0xfe && p.length < 9 && packets.filter((x) => x[0] === 0xfe && x.length < 9).length === 2) break; // second EOF
        }
        const first = packets[0];
        return first[0] === 0xff ? { error: first.subarray(9).toString() } : { raw: Buffer.concat(packets).toString('latin1') };
    };
    return { ok: reply.payload[0] === 0x00, message: reply.payload[0] === 0xff ? reply.payload.subarray(9).toString() : '', query };
}

describe('MySQL logins', () => {
    beforeAll(async () => {
        const kv = new InMemoryKVStore();
        const store = new DocumentStore(kv);
        const privacy = new PrivacyManager(kv);
        const server = new MySQLServer({ store, port: PORT, host: '127.0.0.1', apiKey: MASTER, tls: WireTls.fromFiles(TEST_CERT, TEST_KEY),
            access: new CollectionAccess(privacy, store, new CollectionClaims(privacy)), namespaces: new Namespaces(store, privacy) });
        await server.start();
        stops.push(() => server.stop());
    });

    it('a wallet logs in with its API key over TLS and works in its own namespace', async () => {
        const alice = await mysqlLogin({ user: ALICE, password: KEYS[ALICE], tls: true });
        expect(alice.ok).toBe(true);
        expect(await alice.query("INSERT INTO notes (n) VALUES (1)")).toHaveProperty('raw');
        const bob = await mysqlLogin({ user: BOB, password: KEYS[BOB], tls: true });
        expect(await bob.query(`SELECT * FROM ${ALICE}.notes`)).toMatchObject({ error: expect.stringContaining('Access denied') });
        expect(await bob.query(`INSERT INTO ${ALICE}.notes (n) VALUES (2)`)).toMatchObject({ error: expect.stringContaining('Access denied') });
        expect((await alice.query('SHOW TABLES') as { raw: string }).raw).toContain('notes');
        expect((await bob.query('SHOW TABLES') as { raw: string }).raw).not.toContain('notes');
    });

    it('refuses a wallet login without TLS, before any key is sent', async () => {
        const res = await mysqlLogin({ user: ALICE, password: KEYS[ALICE], tls: false });
        expect(res.ok).toBe(false);
        expect(res.message).toMatch(/need TLS/);
    });

    it("refuses a wrong key, another wallet's key, and an unnamed key of several", async () => {
        expect((await mysqlLogin({ user: ALICE, password: 'pp_test_wrong', tls: true })).message).toMatch(/invalid API key/);
        expect((await mysqlLogin({ user: ALICE, password: KEYS[BOB], tls: true })).ok).toBe(false);
        authContract.getActiveKeys.mockResolvedValue([{ keyIndex: 0 }, { keyIndex: 1 }]);
        expect((await mysqlLogin({ user: ALICE, password: KEYS[ALICE], tls: true })).message).toMatch(/:<keyIndex>/);
        expect((await mysqlLogin({ user: `${ALICE}:0`, password: KEYS[ALICE], tls: true })).ok).toBe(true);
    });

    it('the master key still logs in, with or without TLS', async () => {
        expect((await mysqlLogin({ user: 'root', password: MASTER, tls: false })).ok).toBe(true);
        expect((await mysqlLogin({ user: 'root', password: MASTER, tls: true })).ok).toBe(true);
        expect((await mysqlLogin({ user: 'root', password: 'nope', tls: false })).ok).toBe(false);
    });
});

// ---- Redis ----

const respReply = (buf: Buffer) => {
    const parsed = parseRESP(buf);
    return parsed ? { value: parsed.value, used: parsed.bytesConsumed } : null;
};

async function redisClient(port: number, useTls: boolean) {
    let socket: net.Socket = await (useTls
        ? new Promise<tls.TLSSocket>((resolve, reject) => {
            const s = tls.connect({ port, host: '127.0.0.1', ca: CA, servername: 'localhost' }, () => resolve(s));
            s.once('error', reject);
            s.on('error', () => {});
            sockets.push(s);
        })
        : connect(port));
    const reader = new Reader(socket);
    const send = async (...args: string[]) => {
        socket.write(`*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`);
        const v = await reader.frame(respReply) as { type: string; value: unknown };
        return v.type === 'array' ? (v.value as { value: unknown }[]).map((e) => e.value) : v.value;
    };
    return { send, next: () => reader.frame(respReply), socket };
}

describe('Redis logins and keyspaces', () => {
    const port = PORT + 1;
    let store: InstanceType<typeof DocumentStore>;
    let server: InstanceType<typeof RedisServer>;

    beforeAll(async () => {
        const kv = new InMemoryKVStore();
        store = new DocumentStore(kv);
        server = new RedisServer({ store, kvStore: kv, port, host: '127.0.0.1', apiKey: MASTER, tls: WireTls.fromFiles(TEST_CERT, TEST_KEY) });
        await server.start();
        stops.push(() => server.stop());
    });

    it('a wallet logs in over TLS and gets its own keyspace', async () => {
        const alice = await redisClient(port, true);
        const bob = await redisClient(port, true);
        const operator = await redisClient(port, false);
        expect(await alice.send('AUTH', ALICE, KEYS[ALICE])).toBe('OK');
        expect(await bob.send('AUTH', BOB, KEYS[BOB])).toBe('OK');
        expect(await operator.send('AUTH', MASTER)).toBe('OK');

        await alice.send('SET', 'session', 'alice-data');
        await bob.send('SET', 'session', 'bob-data');
        await operator.send('SET', 'session', 'shared-data');
        expect(await alice.send('GET', 'session')).toBe('alice-data');
        expect(await bob.send('GET', 'session')).toBe('bob-data');
        expect(await operator.send('GET', 'session')).toBe('shared-data');
        await alice.send('HSET', 'profile', 'name', 'Alice');
        expect(await bob.send('HGET', 'profile', 'name')).toBeNull();
        expect(await alice.send('KEYS', '*')).toEqual(['session']);
        expect(await operator.send('KEYS', '*')).toEqual(['session']);
        expect(await alice.send('DBSIZE')).toBe(2);
    });

    it('refuses a wallet login without TLS, and wrong keys', async () => {
        const plain = await redisClient(port, false);
        expect(String(await plain.send('AUTH', ALICE, KEYS[ALICE]))).toMatch(/need TLS/);
        expect(await plain.send('GET', 'session')).toMatch(/NOAUTH/);
        const secure = await redisClient(port, true);
        expect(String(await secure.send('AUTH', ALICE, KEYS[BOB]))).toMatch(/WRONGPASS/);
        authContract.getActiveKeys.mockResolvedValue([{ keyIndex: 0 }, { keyIndex: 3 }]);
        expect(String(await secure.send('AUTH', ALICE, KEYS[ALICE]))).toMatch(/:<keyIndex>/);
    });

    it('FLUSHDB clears only the caller\'s Redis keys — never collections (it used to wipe the whole store)', async () => {
        await store.insert('customer_data', [{ precious: true }]);
        const alice = await redisClient(port, true);
        const bob = await redisClient(port, true);
        const operator = await redisClient(port, false);
        await alice.send('AUTH', ALICE, KEYS[ALICE]);
        await bob.send('AUTH', BOB, KEYS[BOB]);
        await operator.send('AUTH', MASTER);
        await alice.send('SET', 'a', '1');
        await bob.send('SET', 'b', '1');
        await operator.send('SET', 'o', '1');

        expect(await alice.send('FLUSHDB')).toBe('OK');
        expect(await alice.send('DBSIZE')).toBe(0);
        expect(await bob.send('GET', 'b')).toBe('1');
        expect(await operator.send('GET', 'o')).toBe('1');

        expect(await operator.send('FLUSHALL')).toBe('OK');
        expect(await operator.send('GET', 'o')).toBeNull();
        expect(await bob.send('GET', 'b')).toBe('1');
        expect((await store.find('customer_data', {})).cursor.firstBatch).toHaveLength(1);
    });

    it("pub/sub channels are per wallet", async () => {
        const aliceSub = await redisClient(port, true);
        const alicePub = await redisClient(port, true);
        const bobPub = await redisClient(port, true);
        for (const [c, w] of [[aliceSub, ALICE], [alicePub, ALICE], [bobPub, BOB]] as const) await c.send('AUTH', w, KEYS[w]);
        expect(await aliceSub.send('SUBSCRIBE', 'news')).toEqual(['subscribe', 'news', 1]);
        expect(await bobPub.send('PUBLISH', 'news', 'from bob')).toBe(0);
        expect(await alicePub.send('PUBLISH', 'news', 'from alice')).toBe(1);
        const msg = await aliceSub.next() as { value: { value: unknown }[] };
        expect(msg.value.map((v) => v.value)).toEqual(['message', 'news', 'from alice']);
    });

    it('the HTTP passthrough uses the same keyspace as the wallet\'s wire logins', async () => {
        const alice = await redisClient(port, true);
        await alice.send('AUTH', ALICE, KEYS[ALICE]);
        await alice.send('SET', 'via-wire', 'yes');
        let out = Buffer.alloc(0);
        const fake = { write: (d: Buffer) => { out = Buffer.concat([out, d]); }, end: () => {}, destroyed: false };
        await server.executeCommand(fake, ['GET', 'via-wire'], true, ALICE);
        expect(parseRESP(out)?.value.value).toBe('yes');
        out = Buffer.alloc(0);
        await server.executeCommand(fake, ['GET', 'via-wire'], true, BOB);
        expect(parseRESP(out)?.value.value).toBeNull();
    });
});
