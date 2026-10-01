// TLS for the wire ports (MongoDB, PostgreSQL, MySQL, Redis).
//
// Each protocol keeps its one port and accepts both plain and TLS clients:
//   - PostgreSQL and MySQL negotiate it inside the protocol (SSLRequest, the
//     CLIENT_SSL capability), then the connection continues over TLS.
//   - MongoDB and Redis clients start TLS straight away (tls=true, rediss://);
//     the first bytes tell which kind of client connected.
// A proxy in front can't do the first kind, so the servers do TLS themselves.
//
// The certificate comes from files (TLS_CERT_FILE / TLS_KEY_FILE) — in the
// Docker deployment, the one Caddy obtains and renews for the database domain.
// Renewals are picked up without a restart: the files are re-read when they
// change. Missing files (Caddy hasn't obtained the certificate yet) leave TLS
// unavailable — clients are answered as without it — until they appear.

import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

const RELOAD_CHECK_MS = 5 * 60 * 1000;

export class WireTls {
    private secureContext?: tls.SecureContext;
    private loadedMtime = 0;
    private lastError?: string;

    private constructor(private readonly certFile: string, private readonly keyFile: string) {
        this.reloadIfChanged();
        const timer = setInterval(() => this.reloadIfChanged(), RELOAD_CHECK_MS);
        timer.unref?.();
    }

    /** TLS from certificate files, or undefined when not configured. */
    static fromFiles(certFile: string | undefined, keyFile: string | undefined): WireTls | undefined {
        if (!certFile && !keyFile) return undefined;
        if (!certFile || !keyFile) throw new Error('TLS_CERT_FILE and TLS_KEY_FILE must be set together');
        return new WireTls(certFile, keyFile);
    }

    /** A certificate is loaded and TLS can be offered. */
    get ready(): boolean {
        return this.secureContext !== undefined;
    }

    context(): tls.SecureContext {
        if (!this.secureContext) throw new Error('No wire TLS certificate loaded');
        return this.secureContext;
    }

    /** Re-read the files when they changed (a renewed certificate). Keeps the old one if the new is unreadable. */
    reloadIfChanged(): void {
        try {
            if (this.mtime() === this.loadedMtime) return;
            const first = !this.secureContext;
            this.secureContext = this.load();
            this.lastError = undefined;
            console.log(first ? `  [TLS] Wire ports accept TLS (${this.certFile})` : '  [TLS] Reloaded the wire certificate');
        } catch (err) {
            // Logged once per distinct problem, not at every check.
            const message = err instanceof Error ? err.message : String(err);
            if (message === this.lastError) return;
            this.lastError = message;
            console.warn(`  [TLS] ${this.secureContext ? 'Could not reload the' : 'No'} wire certificate (${this.certFile}): ${message}`);
        }
    }

    private mtime(): number {
        return Math.max(fs.statSync(this.certFile).mtimeMs, fs.statSync(this.keyFile).mtimeMs);
    }

    private load(): tls.SecureContext {
        const mtime = this.mtime();
        const context = tls.createSecureContext({ cert: fs.readFileSync(this.certFile), key: fs.readFileSync(this.keyFile), minVersion: 'TLSv1.2' });
        this.loadedMtime = mtime;
        return context;
    }
}

/** Continue `socket` as the server side of a TLS connection. */
export function upgradeToTls(socket: net.Socket, wireTls: WireTls): tls.TLSSocket {
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: wireTls.context() });
    // A failed handshake (scanners, wrong client settings) closes the connection, nothing more.
    secure.on('error', () => secure.destroy());
    return secure;
}

/** A TLS ClientHello: a handshake record (22), version 3.x. Never a valid start of a Redis or MongoDB message. */
export function looksLikeTlsHello(head: Buffer): boolean {
    return head.length >= 3 && head[0] === 0x16 && head[1] === 0x03 && head[2] <= 0x04;
}

/**
 * For protocols whose TLS clients start TLS immediately: look at the first
 * bytes, then hand `handle` the connection — decrypted if it is TLS.
 */
export function acceptMaybeTls(socket: net.Socket, wireTls: WireTls | undefined, handle: (conn: net.Socket, secure: boolean) => void): void {
    if (!wireTls?.ready) {
        handle(socket, false);
        return;
    }
    socket.on('error', () => socket.destroy()); // before a handler is attached
    const peek = () => {
        const head = socket.read(3) as Buffer | null;
        if (head === null) return; // fewer than 3 bytes so far
        socket.removeListener('readable', peek);
        socket.unshift(head);
        if (looksLikeTlsHello(head)) {
            handle(upgradeToTls(socket, wireTls), true);
        } else {
            handle(socket, false);
            socket.resume();
        }
    };
    socket.on('readable', peek);
}

/** Whether a connection is encrypted (a TLSSocket, or a socket upgraded to one). */
export function isSecure(socket: net.Socket): boolean {
    return socket instanceof tls.TLSSocket;
}
