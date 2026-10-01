// TLS on the wire ports: PostgreSQL negotiates it (SSLRequest), MongoDB
// clients start it straight away on the same port as plain clients. Uses a
// self-signed certificate for localhost (fixtures/wire-tls-test.*, test only).

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { BSON } from 'bson';
import { PGServer } from '../protocols/pg-server.js';
import { createWireServer } from '../wire-server.js';
import { WireTls } from '../protocols/wire-tls.js';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { MetricsCollector } from '../metrics.js';
import { PgTestClient, pgSslRequest } from './pg-client.js';
import { TEST_CERT, TEST_KEY } from './tls-fixtures.js';

const CA = fs.readFileSync(TEST_CERT);
const basePort = 47000 + Math.floor(Math.random() * 900);
const cleanup: (() => Promise<void> | void)[] = [];
afterAll(async () => { for (const c of cleanup.reverse()) await c(); }); // clients before their servers

async function startPg(port: number, withTls: boolean) {
    const server = new PGServer({ store: new DocumentStore(new InMemoryKVStore()), port, host: '127.0.0.1', tls: withTls ? WireTls.fromFiles(TEST_CERT, TEST_KEY) : undefined });
    await server.start();
    cleanup.push(() => server.stop());
}

describe('PostgreSQL TLS', () => {
    it('accepts SSLRequest and runs the whole session over TLS', async () => {
        await startPg(basePort, true);
        const { answer, socket } = await pgSslRequest(basePort, CA);
        expect(answer).toBe('S');
        expect((socket as tls.TLSSocket).authorized).toBe(true);
        const client = new PgTestClient(socket);
        cleanup.push(() => client.end());
        // Dev mode (no API key): straight to ReadyForQuery, then queries over TLS.
        const params = Buffer.from('user\0dev\0database\0test\0\0');
        const startup = Buffer.alloc(8);
        startup.writeInt32BE(8 + params.length, 0);
        startup.writeInt32BE(196608, 4);
        socket.write(Buffer.concat([startup, params]));
        for (let m = await client.next(); m.type !== 'Z'; m = await client.next()) { /* AuthenticationOk, params */ }
        expect(await client.query("INSERT INTO tls_t (n) VALUES (1)")).toHaveProperty('rows');
        expect(await client.query('SELECT n FROM tls_t')).toEqual({ rows: ['1'] });
    });

    it('declines SSL when no certificate is configured', async () => {
        await startPg(basePort + 1, false);
        const { answer, socket } = await pgSslRequest(basePort + 1);
        cleanup.push(() => { socket.destroy(); });
        expect(answer).toBe('N');
    });
});

/** One OP_MSG round trip on a connected socket. */
function mongoCommand(socket: net.Socket, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const doc = Buffer.from(BSON.serialize(body));
    const header = Buffer.alloc(21);
    header.writeInt32LE(21 + doc.length, 0);
    header.writeInt32LE(1, 4);
    header.writeInt32LE(0, 8);
    header.writeInt32LE(2013, 12); // OP_MSG
    header.writeUInt32LE(0, 16);   // flags
    header[20] = 0;                // section kind 0
    return new Promise((resolve) => {
        let buf = Buffer.alloc(0);
        const onData = (d: Buffer) => {
            buf = Buffer.concat([buf, d]);
            if (buf.length >= 4 && buf.length >= buf.readInt32LE(0)) {
                socket.removeListener('data', onData);
                resolve(BSON.deserialize(buf.subarray(21)) as Record<string, unknown>);
            }
        };
        socket.on('data', onData);
        socket.write(Buffer.concat([header, doc]));
    });
}

describe('MongoDB TLS', () => {
    it('serves TLS and plain clients on the same port', async () => {
        const port = basePort + 2;
        const server = createWireServer({ port, host: '127.0.0.1', store: new DocumentStore(new InMemoryKVStore()), metrics: new MetricsCollector(), tls: WireTls.fromFiles(TEST_CERT, TEST_KEY) });
        await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
        cleanup.push(() => new Promise<void>((r) => server.close(() => r())));

        const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
            const s = tls.connect({ port, host: '127.0.0.1', ca: CA, servername: 'localhost' }, () => resolve(s));
            s.once('error', reject);
            s.on('error', () => {});
        });
        cleanup.push(() => { secure.destroy(); });
        expect(secure.authorized).toBe(true);
        expect(await mongoCommand(secure, { insert: 'tls_c', documents: [{ n: 1 }], $db: 'test' })).toMatchObject({ ok: 1, n: 1 });

        const plain = await new Promise<net.Socket>((resolve) => { const s = net.connect(port, '127.0.0.1', () => resolve(s)); s.on('error', () => {}); });
        cleanup.push(() => { plain.destroy(); });
        const found = await mongoCommand(plain, { find: 'tls_c', filter: {}, $db: 'test' }) as { cursor: { firstBatch: unknown[] } };
        expect(found.cursor.firstBatch).toHaveLength(1);
    });
});

describe('certificate renewal', () => {
    it('picks up renewed certificate files without a restart', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-tls-'));
        cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const cert = path.join(dir, 'c.crt');
        const key = path.join(dir, 'c.key');
        fs.copyFileSync(TEST_CERT, cert);
        fs.copyFileSync(TEST_KEY, key);
        const wireTls = WireTls.fromFiles(cert, key)!;
        const before = wireTls.context();
        wireTls.reloadIfChanged();
        expect(wireTls.context()).toBe(before); // unchanged files: nothing reloaded
        const later = new Date(Date.now() + 60_000);
        fs.utimesSync(cert, later, later);
        wireTls.reloadIfChanged();
        expect(wireTls.context()).not.toBe(before);
        // A broken renewal keeps the working certificate.
        const current = wireTls.context();
        fs.writeFileSync(cert, 'not a certificate');
        const evenLater = new Date(Date.now() + 120_000);
        fs.utimesSync(cert, evenLater, evenLater);
        wireTls.reloadIfChanged();
        expect(wireTls.context()).toBe(current);
    });

    it('refuses half a configuration', () => {
        expect(() => WireTls.fromFiles(TEST_CERT, undefined)).toThrow(/must be set together/);
        expect(WireTls.fromFiles(undefined, undefined)).toBeUndefined();
    });

    it('starts without the files (not issued yet) and offers TLS once they appear', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-tls-'));
        cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const cert = path.join(dir, 'c.crt');
        const key = path.join(dir, 'c.key');
        const wireTls = WireTls.fromFiles(cert, key)!;
        expect(wireTls.ready).toBe(false);
        const port = basePort + 3;
        const server = new PGServer({ store: new DocumentStore(new InMemoryKVStore()), port, host: '127.0.0.1', tls: wireTls });
        await server.start();
        cleanup.push(() => server.stop());
        const before = await pgSslRequest(port);
        cleanup.push(() => { before.socket.destroy(); });
        expect(before.answer).toBe('N');

        fs.copyFileSync(TEST_CERT, cert);
        fs.copyFileSync(TEST_KEY, key);
        wireTls.reloadIfChanged();
        expect(wireTls.ready).toBe(true);
        const after = await pgSslRequest(port, CA);
        cleanup.push(() => { after.socket.destroy(); });
        expect(after.answer).toBe('S');
    });
});
