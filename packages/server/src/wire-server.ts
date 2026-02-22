// PlugPort Wire Protocol Server
// MongoDB wire protocol (OP_MSG) implementation for driver/mongosh compatibility
// Supports: hello, isMaster, ping, insert, find, update, delete, buildInfo, getLog, whatsmyuri

import * as net from 'net';
import { BSON, ObjectId as BSONObjectId } from 'bson';
import { timingSafeEqual } from 'crypto';
import { DocumentStore, DocumentStoreError } from './storage/document-store.js';
import { MetricsCollector } from './metrics.js';
import { WireProtocol, VERSION } from '@plugport/shared';
import type { Projection, SortSpec } from '@plugport/shared';

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
                        reply = buildOpMsgReply(requestIdCounter++, header.requestID, response);
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
            if (!apiKey) {
                return {
                    conversationId: 1, done: true, payload: Buffer.alloc(0), ok: 1,
                };
            }

            const mechanism = body.mechanism as string;
            if (mechanism !== 'PLAIN') {
                return {
                    ok: 0,
                    errmsg: `Unsupported SASL mechanism ${mechanism}. Server requires PLAIN configuration using API Key.`,
                    code: 332
                };
            }

            try {
                // PLAIN payload format: [authzid] \0 authcid \0 passwd
                const payloadStr = Buffer.from(body.payload as string, 'base64').toString('utf8');
                const parts = payloadStr.split('\0');
                const password = parts[parts.length - 1]; // final component is always the password

                // Constant-time comparison to prevent timing attacks
                const bufA = Buffer.from(password, 'utf-8');
                const bufB = Buffer.from(apiKey, 'utf-8');
                const match = bufA.length === bufB.length && timingSafeEqual(bufA, bufB);

                if (match) {
                    authenticatedConnections.add(connectionId);
                    return { conversationId: 1, done: true, payload: Buffer.alloc(0), ok: 1 };
                }

                return { ok: 0, errmsg: 'Authentication failed.', code: 18 };
            } catch (err) {
                return { ok: 0, errmsg: 'Malformed authentication payload.', code: 18 };
            }
        }
        case 'saslContinue':
            return {
                conversationId: 1,
                done: true,
                payload: Buffer.alloc(0),
                ok: 1,
            };

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
                    id: 0,
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
                    id: 0,
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

            // Basic aggregation support - handle simple $match pipelines
            if (pipeline.length === 0 || (pipeline.length === 1 && pipeline[0].$match)) {
                const filter = pipeline.length > 0 ? normalizeFilter((pipeline[0].$match || {}) as Record<string, unknown>) : {};
                const result = await store.find(collName, filter);
                return {
                    cursor: {
                        firstBatch: result.cursor.firstBatch,
                        id: 0,
                        ns: `${db}.${collName}`,
                    },
                    ok: 1,
                };
            }

            // Empty result for unsupported aggregations
            return {
                cursor: { firstBatch: [], id: 0, ns: `${db}.${collName}` },
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
            return { cursor: { nextBatch: [], id: 0, ns: `${db}.unknown` }, ok: 1 };

        case 'killCursors':
            return { cursorsKilled: [], cursorsNotFound: [], cursorsAlive: [], cursorsUnknown: [], ok: 1 };

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
