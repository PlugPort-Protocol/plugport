// PlugPort Wire Protocol Server
// MongoDB wire protocol (OP_MSG) implementation for driver/mongosh compatibility
// Supports: hello, isMaster, ping, insert, find, update, delete, aggregate ($lookup, $match,
//           $project, $sort, $limit, $skip, $unwind, $count), transactions (best-effort),
//           saslStart/saslContinue (SCRAM-SHA-256 + PLAIN), buildInfo, getLog, whatsmyuri

import * as net from 'net';
import { BSON, ObjectId as BSONObjectId, Long } from 'bson';
import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual, createHash } from 'crypto';
import { DocumentStore, DocumentStoreError } from './storage/document-store.js';
import { MetricsCollector } from './metrics.js';
import { getAuthContract } from './auth/auth-contract.js';
import { WireProtocol, VERSION } from '@plugport/shared';
import type { DocumentWithId, Projection, SortSpec } from '@plugport/shared';

/**
 * BSON deserializes binary fields (like a SASL payload) into a `Binary` wrapper object,
 * not a plain Buffer or base64 string. Extract the raw bytes regardless of which shape
 * we're handed — passing a `Binary` straight to `Buffer.from(x, 'base64')` silently
 * produces an empty buffer instead of throwing, which is easy to miss.
 */
function extractPayloadBuffer(payload: unknown): Buffer {
    if (Buffer.isBuffer(payload)) return payload;
    if (payload && typeof (payload as { value?: unknown }).value === 'function') {
        return Buffer.from((payload as { value: () => Uint8Array }).value());
    }
    if (typeof payload === 'string') return Buffer.from(payload, 'base64');
    return Buffer.alloc(0);
}

// ---- Transaction Session Buffers ----
// Best-effort transactions: buffer writes in memory, flush on commit, discard on abort.
interface BufferedWrite {
    op: 'insert' | 'updateOne' | 'updateMany' | 'deleteOne' | 'deleteMany';
    collection: string;
    args: Record<string, unknown>;
}
const sessionBuffers = new Map<string, BufferedWrite[]>();

// ---- SCRAM-SHA-256 State ----
interface ScramState {
    clientFirstBare: string;
    serverFirstMessage: string;
    serverNonce: string;
    salt: Buffer;
    storedKey: Buffer;
    serverKey: Buffer;
    iterationCount: number;
    createdAt: number; // Unix timestamp for TTL cleanup
}
const scramSessions = new Map<number, ScramState>();

/** Maximum age for SCRAM sessions before cleanup (60 seconds) */
const SCRAM_SESSION_TTL_MS = 60_000;
/** Maximum number of concurrent SCRAM sessions (DoS protection) */
const MAX_SCRAM_SESSIONS = 1000;
/** Maximum number of aggregation pipeline stages */
const MAX_PIPELINE_STAGES = 50;

/** Periodically clean up expired SCRAM sessions */
setInterval(() => {
    const now = Date.now();
    for (const [id, state] of scramSessions) {
        if (now - state.createdAt > SCRAM_SESSION_TTL_MS) {
            scramSessions.delete(id);
        }
    }
}, 30_000).unref(); // unref so timer doesn't prevent process exit

const { OP_MSG, HEADER_SIZE, MAX_WIRE_VERSION, MIN_WIRE_VERSION } = WireProtocol;

/** Maximum allowed wire protocol message size (48MB, matching MongoDB) */
const MAX_MESSAGE_SIZE = 48 * 1024 * 1024;

interface MessageHeader {
    messageLength: number;
    requestID: number;
    responseTo: number;
    opCode: number;
}

interface OpMsgSection {
    kind: number;
    body?: Record<string, unknown>;
    identifier?: string;
    documents?: Record<string, unknown>[];
}

function parseHeader(buf: Buffer): MessageHeader {
    return {
        messageLength: buf.readInt32LE(0),
        requestID: buf.readInt32LE(4),
        responseTo: buf.readInt32LE(8),
        opCode: buf.readInt32LE(12),
    };
}

function parseOpMsg(buf: Buffer): { flagBits: number; sections: OpMsgSection[] } {
    let offset = 0;
    const flagBits = buf.readUInt32LE(offset);
    offset += 4;

    const sections: OpMsgSection[] = [];

    while (offset < buf.length) {
        const kind = buf[offset];
        offset += 1;

        if (kind === 0) {
            // Kind 0: Body - single BSON document
            const docSize = buf.readInt32LE(offset);
            const docBuf = buf.subarray(offset, offset + docSize);
            const doc = BSON.deserialize(docBuf);
            sections.push({ kind: 0, body: doc });
            offset += docSize;
        } else if (kind === 1) {
            // Kind 1: Document sequence
            const sectionSize = buf.readInt32LE(offset);
            const sectionEnd = offset + sectionSize;
            offset += 4;

            // Read identifier (C string)
            let identifierEnd = offset;
            while (identifierEnd < sectionEnd && buf[identifierEnd] !== 0) identifierEnd++;
            const identifier = buf.subarray(offset, identifierEnd).toString('utf-8');
            offset = identifierEnd + 1;

            const documents: Record<string, unknown>[] = [];
            while (offset < sectionEnd) {
                const docSize = buf.readInt32LE(offset);
                const docBuf = buf.subarray(offset, offset + docSize);
                documents.push(BSON.deserialize(docBuf));
                offset += docSize;
            }

            sections.push({ kind: 1, identifier, documents });
        } else {
            break; // Unknown section kind
        }
    }

    return { flagBits, sections };
}

/**
 * Legacy OP_REPLY (opcode 1) — required for responses to OP_QUERY (opcode 2004).
 * Drivers send an OP_QUERY-wrapped hello/isMaster as their first handshake message
 * before they know whether the server supports OP_MSG, and expect an OP_REPLY back,
 * NOT an OP_MSG. Sending OP_MSG framing here desyncs the client's byte-offset
 * assumptions for the rest of the connection, since OP_REPLY has a different
 * (longer) header shape than OP_MSG.
 */
function buildOpReplyMessage(requestID: number, responseTo: number, body: Record<string, unknown>): Buffer {
    const bodyBson = BSON.serialize(body);
    // header(16) + responseFlags(4) + cursorID(8) + startingFrom(4) + numberReturned(4) + document
    const messageLength = HEADER_SIZE + 4 + 8 + 4 + 4 + bodyBson.length;

    const buf = Buffer.alloc(messageLength);
    let offset = 0;

    buf.writeInt32LE(messageLength, offset); offset += 4;
    buf.writeInt32LE(requestID, offset); offset += 4;
    buf.writeInt32LE(responseTo, offset); offset += 4;
    buf.writeInt32LE(1, offset); offset += 4; // opCode = OP_REPLY

    buf.writeInt32LE(0, offset); offset += 4; // responseFlags
    buf.writeBigInt64LE(0n, offset); offset += 8; // cursorID
    buf.writeInt32LE(0, offset); offset += 4; // startingFrom
    buf.writeInt32LE(1, offset); offset += 4; // numberReturned

    Buffer.from(bodyBson).copy(buf, offset);

    return buf;
}

function buildOpMsgReply(requestID: number, responseTo: number, body: Record<string, unknown>): Buffer {
    const bodyBson = BSON.serialize(body);
    const messageLength = HEADER_SIZE + 4 + 1 + bodyBson.length; // header + flagBits + kind + body

    const buf = Buffer.alloc(messageLength);
    let offset = 0;

    // Header
    buf.writeInt32LE(messageLength, offset); offset += 4;
    buf.writeInt32LE(requestID, offset); offset += 4;
    buf.writeInt32LE(responseTo, offset); offset += 4;
    buf.writeInt32LE(OP_MSG, offset); offset += 4;

    // Flag bits
    buf.writeUInt32LE(0, offset); offset += 4;

    // Section kind 0
    buf[offset] = 0; offset += 1;

    // Body BSON
    Buffer.from(bodyBson).copy(buf, offset);

    return buf;
}

// Note: requestIdCounter moved into createWireServer closure (see below)

export interface WireServerOptions {
    port: number;
    host: string;
    apiKey?: string;
    store: DocumentStore;
    metrics: MetricsCollector;
}

export function createWireServer(options: WireServerOptions): net.Server {
    const { store, metrics, apiKey } = options;

    const authenticatedConnections = new Set<number>();

    const server = net.createServer((socket) => {
        metrics.connectionOpened('wire');
        let buffer = Buffer.alloc(0);
        let requestIdCounter = 1; // Per-connection counter for encapsulation
        const connectionId = Math.floor(Math.random() * 1000000);

        // Slowloris DoS protection: Destroy idle connections
        socket.setTimeout(60000);
        socket.on('timeout', () => {
            socket.destroy();
        });

        socket.on('data', async (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);

            // OOM protection: reject connections whose buffer grows beyond MAX_MESSAGE_SIZE
            if (buffer.length > MAX_MESSAGE_SIZE) {
                socket.destroy();
                buffer = Buffer.alloc(0);
                return;
            }

            // Process complete messages
            while (buffer.length >= HEADER_SIZE) {
                const messageLength = buffer.readInt32LE(0);

                // DoS protection: reject oversized messages
                if (messageLength > MAX_MESSAGE_SIZE) {
                    const errResponse = {
                        ok: 0,
                        errmsg: `Message size ${messageLength} exceeds maximum allowed size of ${MAX_MESSAGE_SIZE} bytes`,
                        code: 10334,
                    };
                    const reply = buildOpMsgReply(requestIdCounter++, 0, errResponse);
                    socket.write(reply);
                    socket.destroy();
                    buffer = Buffer.alloc(0);
                    break;
                }

                // DoS protection: reject negative or invalidly small headers preventing parseHeader RangeErrors
                if (messageLength < HEADER_SIZE) {
                    const errResponse = {
                        ok: 0,
                        errmsg: `Invalid message length ${messageLength}. Minimum allowed is ${HEADER_SIZE} bytes.`,
                        code: 10334,
                    };
                    const reply = buildOpMsgReply(requestIdCounter++, 0, errResponse);
                    socket.write(reply);
                    socket.destroy();
                    buffer = Buffer.alloc(0);
                    break;
                }

                if (buffer.length < messageLength) break; // Wait for more data

                const msgBuf = buffer.subarray(0, messageLength);
                buffer = buffer.subarray(messageLength);

                let reqId = 0;
                try {
                    const header = parseHeader(msgBuf);
                    reqId = header.requestID;
                    const startTime = Date.now();
                    let reply: Buffer;

                    if (header.opCode === OP_MSG) {
                        const payload = msgBuf.subarray(HEADER_SIZE);
                        const { sections } = parseOpMsg(payload);
                        const body = sections.find((s) => s.kind === 0)?.body || {};
                        const docSequences = sections.filter((s) => s.kind === 1);

                        const isAuthenticated = !apiKey || authenticatedConnections.has(connectionId);
                        const response = await handleCommand(store, body, docSequences, connectionId, isAuthenticated, apiKey, authenticatedConnections);
                        reply = buildOpMsgReply(requestIdCounter++, header.requestID, response);

                        const command = getCommandName(body);
                        const duration = Date.now() - startTime;
                        metrics.recordRequest(command, 'wire', duration, (response.ok ?? 1) === 1);
                    } else if (header.opCode === 2004) {
                        // OP_QUERY (legacy) - Some drivers send this for initial handshake
                        const response = buildHelloResponse(requestIdCounter);
                        reply = buildOpReplyMessage(requestIdCounter++, header.requestID, response);
                    } else {
                        // Unsupported opcode
                        const response = {
                            ok: 0,
                            errmsg: `Unsupported opcode: ${header.opCode}`,
                            code: 59,
                            codeName: 'CommandNotFound',
                        };
                        reply = buildOpMsgReply(requestIdCounter++, header.requestID, response);
                    }

                    socket.write(reply);
                } catch (err) {
                    const errResponse = {
                        ok: 0,
                        errmsg: err instanceof Error ? err.message : 'Internal error',
                        code: 1,
                    };
                    // Since parseHeader might throw before reading the requestID, default to 0
                    const reply = buildOpMsgReply(requestIdCounter++, reqId, errResponse);
                    socket.write(reply);
                    socket.destroy(); // Unrecoverable stream corruption, drop connection safely
                }
            }
        });

        socket.on('close', () => {
            authenticatedConnections.delete(connectionId);
            metrics.connectionClosed('wire');
        });

        socket.on('error', (err) => {
            if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') {
                console.error('[Wire] Socket error:', err.message);
            }
        });
    });

    return server;
}

function buildHelloResponse(connectionId: number = 0): Record<string, unknown> {
    return {
        ismaster: true,
        helloOk: true,
        maxBsonObjectSize: 16 * 1024 * 1024,
        maxMessageSizeBytes: MAX_MESSAGE_SIZE,
        maxWriteBatchSize: 100000,
        localTime: new Date(),
        logicalSessionTimeoutMinutes: 30,
        connectionId,
        minWireVersion: MIN_WIRE_VERSION,
        maxWireVersion: MAX_WIRE_VERSION,
        readOnly: false,
        ok: 1,
    };
}

function getCommandName(body: Record<string, unknown>): string {
    const commands = ['hello', 'ismaster', 'isMaster', 'ping', 'insert', 'find', 'update', 'delete',
        'buildInfo', 'buildinfo', 'getLog', 'whatsmyuri', 'saslStart', 'saslContinue',
        'endSessions', 'listCollections', 'listDatabases', 'createIndexes', 'drop',
        'aggregate', 'count', 'distinct', 'getMore', 'killCursors', 'create',
        'startTransaction', 'commitTransaction', 'abortTransaction',
        'getFreeMonitoringStatus', 'serverStatus', 'getCmdLineOpts', 'getParameter',
        'hostInfo', 'atlasVersion'];
    for (const cmd of commands) {
        if (cmd in body) return cmd;
    }
    return 'unknown';
}

async function handleCommand(
    store: DocumentStore,
    body: Record<string, unknown>,
    docSequences: OpMsgSection[],
    connectionId: number,
    isAuthenticated: boolean,
    apiKey: string | undefined,
    authenticatedConnections: Set<number>
): Promise<Record<string, unknown>> {
    const command = getCommandName(body);
    const db = (body.$db || 'test') as string;

    // Allow unauthenticated handshakes
    const UNPROTECTED_COMMANDS = ['hello', 'ismaster', 'isMaster', 'buildinfo', 'buildInfo', 'saslStart', 'saslContinue', 'getCmdLineOpts'];
    if (!isAuthenticated && !UNPROTECTED_COMMANDS.includes(command)) {
        return {
            ok: 0,
            errmsg: 'Command requires authentication. Please provide a valid API key.',
            code: 13,
            codeName: 'Unauthorized'
        };
    }

    switch (command) {
        case 'hello':
        case 'ismaster':
        case 'isMaster':
            return buildHelloResponse(connectionId);

        case 'ping':
            return { ok: 1 };

        case 'buildInfo':
        case 'buildinfo':
            return {
                version: '7.0.0',
                gitVersion: 'plugport',
                modules: [],
                allocator: 'system',
                javascriptEngine: 'none',
                sysInfo: 'PlugPort on MonadDb',
                versionArray: [7, 0, 0, 0],
                openssl: { running: 'disabled', compiled: 'disabled' },
                buildEnvironment: {},
                bits: 64,
                debug: false,
                maxBsonObjectSize: 16 * 1024 * 1024,
                storageEngines: ['monaddb'],
                ok: 1,
            };

        case 'getLog':
            return { log: [], totalLinesWritten: 0, ok: 1 };

        case 'whatsmyuri':
            return { you: '127.0.0.1:0', ok: 1 };

        case 'saslStart': {
            const mechanism = body.mechanism as string;

            // ---- SCRAM-SHA-256 authentication ----
            if (mechanism === 'SCRAM-SHA-256') {
                try {
                    const payloadBuf = extractPayloadBuffer(body.payload);
                    const clientFirstMessage = payloadBuf.toString('utf8');

                    // Parse client-first-message: "n,,n=<user>,r=<clientNonce>"
                    const clientFirstBare = clientFirstMessage.replace(/^[npy],,/, '');
                    const clientFields = Object.fromEntries(
                        clientFirstBare.split(',').map(f => [f[0], f.substring(2)])
                    );
                    const username = clientFields['n'] || '';
                    const clientNonce = clientFields['r'] || '';

                    // Generate server nonce
                    const serverNonceBytes = randomBytes(24);
                    const serverNonce = clientNonce + serverNonceBytes.toString('base64');

                    // Derive SCRAM parameters — try on-chain first, then fall back to local
                    let salt: Buffer;
                    let storedKey: Buffer;
                    let serverKey: Buffer;
                    const iterationCount = 4096;
                    let usedOnChain = false;

                    const authContract = getAuthContract();
                    if (authContract.isReadable && username.startsWith('0x')) {
                        // Username is a wallet address — try to read on-chain verifiers
                        // Support format "0xAddress" (defaults to key 0) or "0xAddress:N" (specific key index)
                        let walletAddress = username;
                        let requestedKeyIndex = -1; // -1 = try all active keys
                        const colonIdx = username.indexOf(':', 2);
                        if (colonIdx > 0) {
                            walletAddress = username.substring(0, colonIdx);
                            requestedKeyIndex = parseInt(username.substring(colonIdx + 1), 10);
                        }

                        try {
                            if (requestedKeyIndex >= 0) {
                                // Specific key index requested
                                const verifier = await authContract.getVerifier(walletAddress, requestedKeyIndex);
                                if (verifier && verifier.active) {
                                    salt = Buffer.from(verifier.salt.replace('0x', ''), 'hex').subarray(0, 16);
                                    storedKey = Buffer.from(verifier.storedKey.replace('0x', ''), 'hex');
                                    serverKey = Buffer.from(verifier.serverKey.replace('0x', ''), 'hex');
                                    usedOnChain = true;
                                }
                            } else {
                                // Try all active keys — find the first active one
                                const activeKeys = await authContract.getActiveKeys(walletAddress);
                                if (activeKeys.length > 0) {
                                    // Use the first active key (index 0 is most common)
                                    const firstKey = activeKeys[0];
                                    const verifier = await authContract.getVerifier(walletAddress, firstKey.keyIndex);
                                    if (verifier && verifier.active) {
                                        salt = Buffer.from(verifier.salt.replace('0x', ''), 'hex').subarray(0, 16);
                                        storedKey = Buffer.from(verifier.storedKey.replace('0x', ''), 'hex');
                                        serverKey = Buffer.from(verifier.serverKey.replace('0x', ''), 'hex');
                                        usedOnChain = true;
                                    }
                                }
                            }
                        } catch {
                            // On-chain lookup failed — fall through to local derivation
                        }
                    }

                    if (!usedOnChain) {
                        // Fallback: derive from the legacy apiKey
                        salt = createHash('sha256').update(`${apiKey || 'plugport'}:scram-salt`).digest().subarray(0, 16);
                        const saltedPassword = pbkdf2Sync(apiKey || '', salt, iterationCount, 32, 'sha256');
                        const clientKeyHmac = createHmac('sha256', saltedPassword).update('Client Key').digest();
                        storedKey = createHash('sha256').update(clientKeyHmac).digest();
                        serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
                    }

                    // Build server-first-message
                    const serverFirstMessage = `r=${serverNonce},s=${salt!.toString('base64')},i=${iterationCount}`;

                    // Store SCRAM state for saslContinue
                    // Enforce max concurrent sessions to prevent memory abuse
                    if (scramSessions.size >= MAX_SCRAM_SESSIONS) {
                        // Evict oldest session
                        let oldestId = -1;
                        let oldestTime = Infinity;
                        for (const [id, state] of scramSessions) {
                            if (state.createdAt < oldestTime) {
                                oldestTime = state.createdAt;
                                oldestId = id;
                            }
                        }
                        if (oldestId >= 0) scramSessions.delete(oldestId);
                    }
                    scramSessions.set(connectionId, {
                        clientFirstBare,
                        serverFirstMessage,
                        serverNonce,
                        salt: salt!,
                        storedKey: storedKey!,
                        serverKey: serverKey!,
                        iterationCount,
                        createdAt: Date.now(),
                    });

                    return {
                        conversationId: 1,
                        done: false,
                        payload: Buffer.from(serverFirstMessage, 'utf8'),
                        ok: 1,
                    };
                } catch {
                    return { ok: 0, errmsg: 'SCRAM-SHA-256 saslStart failed.', code: 18 };
                }
            }

            // ---- PLAIN authentication (fallback) ----
            if (mechanism === 'PLAIN') {
                if (!apiKey) {
                    return { conversationId: 1, done: true, payload: Buffer.alloc(0), ok: 1 };
                }

                try {
                    const payloadStr = extractPayloadBuffer(body.payload).toString('utf8');
                    const parts = payloadStr.split('\0');
                    const password = parts[parts.length - 1];

                    const bufA = Buffer.from(password, 'utf-8');
                    const bufB = Buffer.from(apiKey, 'utf-8');
                    const match = bufA.length === bufB.length && timingSafeEqual(bufA, bufB);

                    if (match) {
                        authenticatedConnections.add(connectionId);
                        return { conversationId: 1, done: true, payload: Buffer.alloc(0), ok: 1 };
                    }
                    return { ok: 0, errmsg: 'Authentication failed.', code: 18 };
                } catch {
                    return { ok: 0, errmsg: 'Malformed authentication payload.', code: 18 };
                }
            }

            // No auth configured — allow all
            if (!apiKey) {
                return { conversationId: 1, done: true, payload: Buffer.alloc(0), ok: 1 };
            }

            return {
                ok: 0,
                errmsg: `Unsupported SASL mechanism: ${mechanism}. Supported: SCRAM-SHA-256, PLAIN.`,
                code: 332,
            };
        }

        case 'saslContinue': {
            const scramState = scramSessions.get(connectionId);
            if (!scramState) {
                // No SCRAM session — might be a continuation of PLAIN (already done)
                return { conversationId: 1, done: true, payload: Buffer.alloc(0), ok: 1 };
            }

            try {
                const payloadBuf = extractPayloadBuffer(body.payload);
                const clientFinalMessage = payloadBuf.toString('utf8');

                // Parse client-final-message: "c=<channelBinding>,r=<nonce>,p=<proof>"
                const clientFields = Object.fromEntries(
                    clientFinalMessage.split(',').map(f => {
                        const eqIdx = f.indexOf('=');
                        return [f.substring(0, eqIdx), f.substring(eqIdx + 1)];
                    })
                );
                const clientProof = Buffer.from(clientFields['p'] || '', 'base64');
                const clientNonce = clientFields['r'] || '';

                // Verify nonce matches
                if (clientNonce !== scramState.serverNonce) {
                    scramSessions.delete(connectionId);
                    return { ok: 0, errmsg: 'SCRAM nonce mismatch.', code: 18 };
                }

                // Compute AuthMessage
                const clientFinalWithoutProof = clientFinalMessage.substring(0, clientFinalMessage.lastIndexOf(',p='));
                const authMessage = `${scramState.clientFirstBare},${scramState.serverFirstMessage},${clientFinalWithoutProof}`;

                // Verify ClientProof
                const clientSignature = createHmac('sha256', scramState.storedKey).update(authMessage).digest();
                const recoveredClientKey = Buffer.alloc(clientProof.length);
                for (let i = 0; i < clientProof.length; i++) {
                    recoveredClientKey[i] = clientProof[i] ^ clientSignature[i];
                }
                const recoveredStoredKey = createHash('sha256').update(recoveredClientKey).digest();

                if (!timingSafeEqual(recoveredStoredKey, scramState.storedKey)) {
                    scramSessions.delete(connectionId);
                    return { ok: 0, errmsg: 'Authentication failed.', code: 18 };
                }

                // Compute ServerSignature for mutual authentication
                const serverSignature = createHmac('sha256', scramState.serverKey).update(authMessage).digest();
                const serverFinalMessage = `v=${serverSignature.toString('base64')}`;

                // Mark connection as authenticated
                authenticatedConnections.add(connectionId);
                scramSessions.delete(connectionId);

                return {
                    conversationId: 1,
                    done: true,
                    payload: Buffer.from(serverFinalMessage, 'utf8'),
                    ok: 1,
                };
            } catch {
                scramSessions.delete(connectionId);
                return { ok: 0, errmsg: 'SCRAM-SHA-256 saslContinue failed.', code: 18 };
            }
        }

        case 'getFreeMonitoringStatus':
            return { state: 'disabled', ok: 1 };

        case 'serverStatus':
            return {
                host: 'plugport',
                version: '7.0.0',
                process: 'plugport',
                pid: process.pid,
                uptime: process.uptime(),
                uptimeMillis: process.uptime() * 1000,
                ok: 1,
            };

        case 'getCmdLineOpts':
            return { argv: ['plugport'], parsed: {}, ok: 1 };

        case 'getParameter':
            return { ok: 1 };

        case 'hostInfo':
            return { system: { currentTime: new Date(), hostname: 'plugport' }, os: {}, extra: {}, ok: 1 };

        case 'atlasVersion':
            return { ok: 0, errmsg: 'not supported', code: 59 };

        case 'listDatabases':
            return {
                databases: [{ name: db, sizeOnDisk: 0, empty: false }],
                totalSize: 0,
                ok: 1,
            };

        case 'listCollections': {
            const collections = await store.listCollections();
            return {
                cursor: {
                    firstBatch: collections.map((c) => ({
                        name: c.name,
                        type: 'collection',
                        options: {},
                        info: { readOnly: false },
                        idIndex: { v: 2, key: { _id: 1 }, name: '_id_' },
                    })),
                    id: Long.fromNumber(0),
                    ns: `${db}.$cmd.listCollections`,
                },
                ok: 1,
            };
        }

        case 'create': {
            const collName = body.create as string;
            await store.getOrCreateCollection(collName);
            return { ok: 1 };
        }

        case 'drop': {
            const collName = body.drop as string;
            await store.dropCollection(collName);
            return { ok: 1 };
        }

        case 'insert': {
            const collName = body.insert as string;
            let documents: Record<string, unknown>[] = (body.documents as Record<string, unknown>[]) || [];

            // Check document sequences (kind 1)
            for (const seq of docSequences) {
                if (seq.identifier === 'documents' && seq.documents) {
                    documents = documents.concat(seq.documents);
                }
            }

            // Convert BSON ObjectIds to strings
            documents = documents.map(normalizeDocument);

            try {
                const result = await store.insert(collName, documents);
                return { n: result.insertedCount, ok: 1 };
            } catch (err) {
                if (err instanceof DocumentStoreError) {
                    return {
                        n: 0,
                        writeErrors: [{ index: 0, code: err.code, errmsg: err.message }],
                        ok: 1,
                    };
                }
                throw err;
            }
        }

        case 'find': {
            const collName = body.find as string;
            const filter = normalizeFilter((body.filter || {}) as Record<string, unknown>);
            const projection = body.projection as Projection | undefined;
            const sort = body.sort as SortSpec | undefined;
            const limit = body.limit as number | undefined;
            const skip = body.skip as number | undefined;

            const result = await store.find(collName, filter, { projection, sort, limit, skip });

            return {
                cursor: {
                    firstBatch: result.cursor.firstBatch,
                    id: Long.fromNumber(0),
                    ns: `${db}.${collName}`,
                },
                ok: 1,
            };
        }

        case 'update': {
            const collName = body.update as string;
            let updates: Record<string, unknown>[] = (body.updates as Record<string, unknown>[]) || [];

            for (const seq of docSequences) {
                if (seq.identifier === 'updates' && seq.documents) {
                    updates = updates.concat(seq.documents);
                }
            }

            let totalMatched = 0;
            let totalModified = 0;
            const writeErrors: Record<string, unknown>[] = [];

            for (let i = 0; i < updates.length; i++) {
                const upd = updates[i];
                const filter = normalizeFilter((upd.q || {}) as Record<string, unknown>);
                const update = upd.u as Record<string, unknown>;
                const upsert = upd.upsert as boolean | undefined;
                const multi = upd.multi === true;

                try {
                    let result;
                    if (multi) {
                        result = await store.updateMany(collName, filter, update as { $set?: Record<string, unknown>; $inc?: Record<string, number>; $unset?: Record<string, unknown> }, { upsert });
                    } else {
                        result = await store.updateOne(collName, filter, update as { $set?: Record<string, unknown>; $inc?: Record<string, number>; $unset?: Record<string, unknown> }, { upsert });
                    }
                    totalMatched += result.matchedCount;
                    totalModified += result.modifiedCount;
                } catch (err) {
                    if (err instanceof DocumentStoreError) {
                        writeErrors.push({ index: i, code: err.code, errmsg: err.message });
                    }
                }
            }

            const response: Record<string, unknown> = {
                n: totalMatched,
                nModified: totalModified,
                ok: 1,
            };
            if (writeErrors.length > 0) response.writeErrors = writeErrors;
            return response;
        }

        case 'delete': {
            const collName = body.delete as string;
            let deletes: Record<string, unknown>[] = (body.deletes as Record<string, unknown>[]) || [];

            for (const seq of docSequences) {
                if (seq.identifier === 'deletes' && seq.documents) {
                    deletes = deletes.concat(seq.documents);
                }
            }

            let totalDeleted = 0;

            for (const del of deletes) {
                const filter = normalizeFilter((del.q || {}) as Record<string, unknown>);
                const limit = del.limit as number | undefined;

                if (limit === 0 || !limit) {
                    // deleteMany
                    const result = await store.deleteMany(collName, filter);
                    totalDeleted += result.deletedCount;
                } else {
                    const result = await store.deleteOne(collName, filter);
                    totalDeleted += result.deletedCount;
                }
            }

            return { n: totalDeleted, ok: 1 };
        }

        case 'createIndexes': {
            const collName = body.createIndexes as string;
            const indexes = body.indexes as Array<{ key: Record<string, number>; name?: string; unique?: boolean }>;

            for (const idx of indexes) {
                const fields = Object.keys(idx.key);
                for (const field of fields) {
                    await store.createIndex(collName, field, idx.unique);
                }
            }

            return { createdCollectionAutomatically: false, numIndexesBefore: 1, numIndexesAfter: 1, ok: 1 };
        }

        case 'aggregate': {
            const collName = body.aggregate as string;
            const pipeline = (body.pipeline || []) as Record<string, unknown>[];

            // B4: Cap pipeline stage count to prevent DoS
            if (pipeline.length > MAX_PIPELINE_STAGES) {
                return {
                    ok: 0,
                    errmsg: `Pipeline exceeds maximum of ${MAX_PIPELINE_STAGES} stages (got ${pipeline.length})`,
                    code: 15942,
                };
            }

            // Execute pipeline stages sequentially
            let docs: Record<string, unknown>[] = [];

            // Fetch initial documents from the collection
            const initialResult = await store.find(collName, {});
            docs = initialResult.cursor.firstBatch as Record<string, unknown>[];

            for (const stage of pipeline) {
                const stageKey = Object.keys(stage)[0];

                switch (stageKey) {
                    case '$match': {
                        const matchFilter = normalizeFilter(stage.$match as Record<string, unknown>);
                        const { matchesFilter: matchFn } = await import('./storage/query-planner.js');
                        docs = docs.filter(doc => matchFn(doc as DocumentWithId, matchFilter));
                        break;
                    }

                    case '$lookup': {
                        const lookup = stage.$lookup as {
                            from: string;
                            localField: string;
                            foreignField: string;
                            as: string;
                        };

                        // Batch-fetch: collect all local field values, use $in on foreign collection
                        const localValues = docs.map(doc => getNestedField(doc, lookup.localField)).filter(v => v !== undefined && v !== null);
                        const uniqueValues = [...new Set(localValues.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)))];

                        let foreignDocs: Record<string, unknown>[] = [];
                        if (uniqueValues.length > 0) {
                            const foreignResult = await store.find(lookup.from, {
                                [lookup.foreignField]: { $in: localValues },
                            });
                            foreignDocs = foreignResult.cursor.firstBatch as Record<string, unknown>[];
                        }

                        // I2: Warn when foreign collection is large
                        if (foreignDocs.length > 10_000) {
                            console.warn(`[Wire] $lookup: foreign collection "${lookup.from}" returned ${foreignDocs.length} documents — consider filtering or indexing`);
                        }

                        // Build lookup index: foreignField value → matching docs
                        const lookupIndex = new Map<string, Record<string, unknown>[]>();
                        for (const fdoc of foreignDocs) {
                            const key = String(getNestedField(fdoc, lookup.foreignField) ?? '');
                            if (!lookupIndex.has(key)) lookupIndex.set(key, []);
                            lookupIndex.get(key)!.push(fdoc);
                        }

                        // Embed matched docs as array under the 'as' field
                        docs = docs.map(doc => {
                            const localVal = String(getNestedField(doc, lookup.localField) ?? '');
                            return { ...doc, [lookup.as]: lookupIndex.get(localVal) || [] };
                        });
                        break;
                    }

                    case '$project': {
                        const projection = stage.$project as Record<string, unknown>;
                        const include = Object.entries(projection).filter(([, v]) => v === 1 || v === true);
                        const exclude = Object.entries(projection).filter(([, v]) => v === 0 || v === false);

                        if (include.length > 0) {
                            const includeFields = new Set(include.map(([k]) => k));
                            includeFields.add('_id'); // Always include _id unless explicitly excluded
                            if (projection._id === 0 || projection._id === false) includeFields.delete('_id');
                            docs = docs.map(doc => {
                                const result: Record<string, unknown> = {};
                                for (const field of includeFields) {
                                    if (field in doc) result[field] = doc[field];
                                }
                                return result;
                            });
                        } else if (exclude.length > 0) {
                            const excludeFields = new Set(exclude.map(([k]) => k));
                            docs = docs.map(doc => {
                                const result: Record<string, unknown> = {};
                                for (const [k, v] of Object.entries(doc)) {
                                    if (!excludeFields.has(k)) result[k] = v;
                                }
                                return result;
                            });
                        }
                        break;
                    }

                    case '$sort': {
                        const sortSpec = stage.$sort as Record<string, number>;
                        docs.sort((a, b) => {
                            for (const [field, direction] of Object.entries(sortSpec)) {
                                const aVal = getNestedField(a, field) as any;
                                const bVal = getNestedField(b, field) as any;
                                if (aVal < bVal) return -1 * direction;
                                if (aVal > bVal) return 1 * direction;
                            }
                            return 0;
                        });
                        break;
                    }

                    case '$limit': {
                        docs = docs.slice(0, stage.$limit as number);
                        break;
                    }

                    case '$skip': {
                        docs = docs.slice(stage.$skip as number);
                        break;
                    }

                    case '$unwind': {
                        const path = (typeof stage.$unwind === 'string' ? stage.$unwind : (stage.$unwind as { path: string }).path).replace(/^\$/, '');
                        const unwound: Record<string, unknown>[] = [];
                        for (const doc of docs) {
                            const arr = getNestedField(doc, path);
                            if (Array.isArray(arr)) {
                                for (const item of arr) {
                                    unwound.push({ ...doc, [path]: item });
                                }
                            } else if (arr !== undefined && arr !== null) {
                                unwound.push(doc); // Non-array values pass through
                            }
                            // Documents with null/missing/empty array are dropped
                        }
                        docs = unwound;
                        break;
                    }

                    case '$count': {
                        const countField = stage.$count as string;
                        docs = [{ [countField]: docs.length }];
                        break;
                    }

                    default:
                        // I1: Warn on unsupported pipeline stages instead of silently skipping
                        console.warn(`[Wire] Unsupported aggregation stage: "${stageKey}" — skipped`);
                        break;
                }
            }

            return {
                cursor: {
                    firstBatch: docs,
                    id: Long.fromNumber(0),
                    ns: `${db}.${collName}`,
                },
                ok: 1,
            };
        }

        case 'count': {
            const collName = body.count as string;
            const filter = normalizeFilter((body.query || {}) as Record<string, unknown>);
            const result = await store.find(collName, filter);
            return { n: result.cursor.firstBatch.length, ok: 1 };
        }

        case 'distinct': {
            const collName = body.distinct as string;
            const field = body.key as string;
            const filter = normalizeFilter((body.query || {}) as Record<string, unknown>);
            const result = await store.find(collName, filter);
            const values = new Set(result.cursor.firstBatch.map((d) => (d as Record<string, unknown>)[field]));
            return { values: Array.from(values), ok: 1 };
        }

        case 'getMore':
            return { cursor: { nextBatch: [], id: Long.fromNumber(0), ns: `${db}.unknown` }, ok: 1 };

        case 'killCursors':
            return { cursorsKilled: [], cursorsNotFound: [], cursorsAlive: [], cursorsUnknown: [], ok: 1 };

        // ---- Transaction commands (best-effort) ----
        case 'startTransaction': {
            const lsid = body.lsid as { id: string } | undefined;
            const sessionId = lsid?.id || `session-${connectionId}`;
            sessionBuffers.set(sessionId, []);
            return { ok: 1 };
        }

        case 'commitTransaction': {
            const lsid = body.lsid as { id: string } | undefined;
            const sessionId = lsid?.id || `session-${connectionId}`;
            const buffer = sessionBuffers.get(sessionId);
            if (!buffer) return { ok: 1 };

            // Flush buffered writes sequentially (best-effort, not atomic)
            for (const write of buffer) {
                try {
                    switch (write.op) {
                        case 'insert':
                            await store.insert(write.collection, [write.args as Record<string, unknown>]);
                            break;
                        case 'updateOne':
                            await store.updateOne(write.collection, write.args.filter as Record<string, unknown>, write.args.update as any);
                            break;
                        case 'updateMany':
                            await store.updateMany(write.collection, write.args.filter as Record<string, unknown>, write.args.update as any);
                            break;
                        case 'deleteOne':
                            await store.deleteOne(write.collection, write.args.filter as Record<string, unknown>);
                            break;
                        case 'deleteMany':
                            await store.deleteMany(write.collection, write.args.filter as Record<string, unknown>);
                            break;
                    }
                } catch (err: any) {
                    sessionBuffers.delete(sessionId);
                    return { ok: 0, errmsg: `Transaction commit failed: ${err.message}`, code: 251 };
                }
            }

            sessionBuffers.delete(sessionId);
            return { ok: 1 };
        }

        case 'abortTransaction': {
            const lsid = body.lsid as { id: string } | undefined;
            const sessionId = lsid?.id || `session-${connectionId}`;
            sessionBuffers.delete(sessionId); // Discard all buffered writes
            return { ok: 1 };
        }

        default:
            return {
                ok: 0,
                errmsg: `no such command: '${command}'`,
                code: 59,
                codeName: 'CommandNotFound',
            };
    }
}

/**
 * Normalize BSON ObjectIds to string representations.
 */
function normalizeDocument(doc: Record<string, unknown>, depth: number = 0): Record<string, unknown> {
    if (depth > 20) {
        throw new Error('Document nesting exceeds maximum depth of 20');
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(doc)) {
        if (value instanceof BSONObjectId) {
            result[key] = value.toHexString();
        } else if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !Buffer.isBuffer(value)) {
            result[key] = normalizeDocument(value as Record<string, unknown>, depth + 1);
        } else if (Array.isArray(value)) {
            result[key] = value.map((v) =>
                v instanceof BSONObjectId ? v.toHexString() :
                    (v && typeof v === 'object' ? normalizeDocument(v as Record<string, unknown>, depth + 1) : v)
            );
        } else {
            result[key] = value;
        }
    }
    return result;
}

function normalizeFilter(filter: Record<string, unknown>): Record<string, unknown> {
    return normalizeDocument(filter);
}

/**
 * Get a nested field value from a document using dot notation.
 * e.g., getNestedField({a: {b: 1}}, 'a.b') => 1
 */
function getNestedField(doc: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = doc;
    for (const part of parts) {
        if (current === null || current === undefined || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}
