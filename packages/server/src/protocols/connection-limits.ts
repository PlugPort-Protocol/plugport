// Memory bounds for the wire-protocol servers.
//
// The wire ports are reachable from the internet, and on 2026-09-27 the server
// died of a V8 heap OOM: the heap went from 43 MB to its 259 MB limit in under
// 15 seconds with no HTTP traffic and 22 wire connections open. What a client
// sends is parsed into JavaScript objects, which are far larger than the bytes
// on the wire — measured: BSON 6.5x, JSON up to 21x, SQL (node-sql-parser AST)
// 67-200x (SQL text is already capped at 10,000 characters). MongoDB accepted
// 48 MB messages before authentication, and the PostgreSQL, MySQL and Redis
// servers accepted input of any size.
//
// Before authentication a client only needs to send a handshake, so it gets
// PRE_AUTH_MAX_BYTES. After it, the per-protocol caps below keep the parsed
// form of one worst-case message well inside the heap.

import type net from 'node:net';

/** Anything an unauthenticated client may make the server buffer. Handshakes and logins are well under 4 KB. */
export const PRE_AUTH_MAX_BYTES = 64 * 1024;

/** MongoDB OP_MSG size for authenticated connections (advertised as maxMessageSizeBytes). ~52 MB parsed, worst case. */
export const MONGO_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** PostgreSQL / MySQL message size for authenticated connections. Query text is capped separately (10,000 chars, SQLTranslator). */
export const SQL_WIRE_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/** Redis bytes buffered for one authenticated connection. */
export const REDIS_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** Elements in one Redis command array; each parsed element is an object plus a string. */
export const REDIS_MAX_ARRAY_ELEMENTS = 100_000;

/** Connections per protocol server. */
export const MAX_CONNECTIONS_PER_PROTOCOL = 256;

/** How long a connection may stay open without authenticating. */
export const AUTH_DEADLINE_MS = 30_000;

/**
 * Close `socket` if it has not authenticated within `ms`. Not for MongoDB:
 * drivers keep unauthenticated monitoring connections open by design.
 */
export function closeUnlessAuthenticatedWithin(socket: net.Socket, isAuthenticated: () => boolean, ms = AUTH_DEADLINE_MS): void {
    const timer = setTimeout(() => {
        if (!isAuthenticated()) socket.destroy();
    }, ms);
    timer.unref?.();
    socket.once('close', () => clearTimeout(timer));
}
