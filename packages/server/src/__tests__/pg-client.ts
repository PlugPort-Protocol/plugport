// A minimal PostgreSQL client for tests: startup, SCRAM-SHA-256 login, simple
// queries — over a plain socket or TLS (after an SSLRequest).

import net from 'node:net';
import tls from 'node:tls';
import { expect } from 'vitest';
import { scramLogin } from './scram-client.js';

type Msg = { type: string; body: Buffer };

/** A minimal PostgreSQL client: startup, SCRAM, simple queries. */
export class PgTestClient {
    private socket: net.Socket;
    private buf = Buffer.alloc(0);
    private queue: Msg[] = [];
    private waiters: ((m: Msg) => void)[] = [];
    closed = false;

    /** A port to connect to, or an already connected socket (e.g. TLS after SSLRequest). */
    constructor(target: number | net.Socket) {
        this.socket = typeof target === 'number' ? net.connect(target, '127.0.0.1') : target;
        this.socket.on('error', () => {}); // resets at teardown must not crash the test worker
        this.socket.on('data', (d) => {
            this.buf = Buffer.concat([this.buf, d]);
            while (this.buf.length >= 5) {
                const len = this.buf.readInt32BE(1);
                if (this.buf.length < 1 + len) break;
                const m = { type: String.fromCharCode(this.buf[0]), body: this.buf.subarray(5, 1 + len) };
                this.buf = this.buf.subarray(1 + len);
                const w = this.waiters.shift();
                if (w) w(m); else this.queue.push(m);
            }
        });
        this.socket.on('close', () => { this.closed = true; });
    }

    next(): Promise<Msg> {
        const m = this.queue.shift();
        return m ? Promise.resolve(m) : new Promise((r) => this.waiters.push(r));
    }

    send(type: string, body: Buffer) {
        const head = Buffer.alloc(5);
        head.write(type, 0);
        head.writeInt32BE(4 + body.length, 1);
        this.socket.write(Buffer.concat([head, body]));
    }

    /** Log in; resolves to the error text, or null on success (after ReadyForQuery). */
    async login(user: string, password: string): Promise<string | null> {
        const params = Buffer.from(`user\0${user}\0database\0test\0\0`);
        const startup = Buffer.alloc(8);
        startup.writeInt32BE(8 + params.length, 0);
        startup.writeInt32BE(196608, 4);
        this.socket.write(Buffer.concat([startup, params]));

        const offer = await this.next();
        expect(offer.type).toBe('R');
        expect(offer.body.readInt32BE(0)).toBe(10); // AuthenticationSASL, not cleartext
        expect(offer.body.subarray(4).toString()).toContain('SCRAM-SHA-256');

        let error: string | null = null;
        const { serverVerified } = await scramLogin('', password, async (msg, step) => {
            if (step === 1) {
                const len = Buffer.alloc(4);
                len.writeInt32BE(Buffer.byteLength(msg));
                this.send('p', Buffer.concat([Buffer.from('SCRAM-SHA-256\0'), len, Buffer.from(msg)]));
            } else {
                this.send('p', Buffer.from(msg));
            }
            const reply = await this.next();
            if (reply.type === 'E') { error = errorText(reply); throw new Error(error); }
            expect(reply.body.readInt32BE(0)).toBe(step === 1 ? 11 : 12);
            return reply.body.subarray(4).toString();
        }).catch(() => ({ serverVerified: false }));
        if (error) return error;
        expect(serverVerified).toBe(true);
        for (let m = await this.next(); m.type !== 'Z'; m = await this.next()) {
            if (m.type === 'E') return errorText(m);
            expect(m.type === 'R' ? m.body.readInt32BE(0) : 0).toBe(0); // AuthenticationOk, then params
        }
        return null;
    }

    /** Run a simple query: rows (first column values) or the error text. */
    async query(sql: string): Promise<{ rows: string[] } | { error: string }> {
        this.send('Q', Buffer.from(`${sql}\0`));
        const rows: string[] = [];
        let error: string | undefined;
        for (let m = await this.next(); m.type !== 'Z'; m = await this.next()) {
            if (m.type === 'E') error = errorText(m);
            if (m.type === 'D') {
                const len = m.body.readInt32BE(2);
                rows.push(len < 0 ? '' : m.body.subarray(6, 6 + len).toString());
            }
        }
        return error !== undefined ? { error } : { rows };
    }

    end() { this.socket.destroy(); }
}

function errorText(m: Msg): string {
    const field = m.body.toString().split('\0').find((f) => f.startsWith('M'));
    return field ? field.substring(1) : '';
}

/** Ask for SSL: resolves to the server's answer ('S' or 'N') and the socket to continue on. */
export function pgSslRequest(port: number, ca?: Buffer): Promise<{ answer: string; socket: net.Socket }> {
    return new Promise((resolve, reject) => {
        const raw = net.connect(port, '127.0.0.1', () => {
            const req = Buffer.alloc(8);
            req.writeInt32BE(8, 0);
            req.writeInt32BE(80877103, 4);
            raw.write(req);
        });
        raw.once('error', reject);
        raw.on('error', () => {});
        raw.once('data', (d) => {
            const answer = String.fromCharCode(d[0]);
            if (answer !== 'S') return resolve({ answer, socket: raw });
            const secure = tls.connect({ socket: raw, ca, servername: 'localhost' }, () => resolve({ answer, socket: secure }));
            secure.once('error', reject);
            secure.on('error', () => {});
        });
    });
}
