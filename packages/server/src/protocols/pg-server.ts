// PlugPort PostgreSQL Wire Protocol Server
// Implements the PostgreSQL Frontend/Backend protocol (v3).
// Accepts connections from psql, Prisma, Sequelize, Knex, TypeORM, etc.
// Translates SQL → DocumentStore operations via SQLTranslator + JoinEngine.
//
// Protocol reference: https://www.postgresql.org/docs/current/protocol.html
//
// Message flow:
//   Client → StartupMessage (with params)
//   Server → AuthenticationOk → ParameterStatus → ReadyForQuery
//   Client → Query (simple SQL)
//   Server → RowDescription → DataRow(s) → CommandComplete → ReadyForQuery

import net from 'net';
import { timingSafeEqual } from 'node:crypto';
import { DocumentStore } from '../storage/document-store.js';
import { SQLTranslator, executeAggregation, type TranslatedQuery } from './sql-translator.js';
import { JoinEngine } from './join-engine.js';
import type { ProtocolServerInstance } from './protocol-manager.js';
import type { MetricsCollector } from '../metrics.js';
import type { ProtocolType, DocumentWithId } from '@plugport/shared';

/** Constant-time string comparison to prevent timing attacks on the password. */
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

// ---- PG Message Types ----

const PG_MSG = {
    // Frontend (client → server)
    QUERY: 'Q'.charCodeAt(0),          // Simple query
    PARSE: 'P'.charCodeAt(0),          // Extended query: parse
    BIND: 'B'.charCodeAt(0),           // Extended query: bind
    DESCRIBE: 'D'.charCodeAt(0),       // Describe
    EXECUTE: 'E'.charCodeAt(0),        // Execute
    CLOSE: 'C'.charCodeAt(0),          // Close (statement or portal)
    SYNC: 'S'.charCodeAt(0),           // Sync
    TERMINATE: 'X'.charCodeAt(0),      // Terminate
    PASSWORD: 'p'.charCodeAt(0),       // Password message

    // Backend (server → client)
    AUTH: 'R'.charCodeAt(0),           // Authentication
    PARAM_STATUS: 'S'.charCodeAt(0),   // ParameterStatus
    BACKEND_KEY: 'K'.charCodeAt(0),    // BackendKeyData
    READY: 'Z'.charCodeAt(0),          // ReadyForQuery
    ROW_DESC: 'T'.charCodeAt(0),       // RowDescription
    DATA_ROW: 'D'.charCodeAt(0),       // DataRow
    CMD_COMPLETE: 'C'.charCodeAt(0),   // CommandComplete
    ERROR: 'E'.charCodeAt(0),          // ErrorResponse
    NOTICE: 'N'.charCodeAt(0),         // NoticeResponse
    EMPTY_QUERY: 'I'.charCodeAt(0),    // EmptyQueryResponse
    NO_DATA: 'n'.charCodeAt(0),        // NoData
    PARSE_COMPLETE: '1'.charCodeAt(0), // ParseComplete
    BIND_COMPLETE: '2'.charCodeAt(0),  // BindComplete
    CLOSE_COMPLETE: '3'.charCodeAt(0), // CloseComplete
} as const;

// ---- Extended Query Protocol state ----
// Tracked per-connection so Parse/Bind/Execute (used by most real drivers
// and ORMs for parameterized queries — node-postgres, Prisma, Sequelize,
// Knex, TypeORM, etc.) actually run against the store, instead of Execute
// unconditionally returning a fake "0 rows" response.

interface PreparedStatement {
    sql: string; // raw SQL text with $1, $2, ... placeholders, as sent by Parse
}

interface Portal {
    statementName: string;
    paramValues: (Buffer | null)[];
}

// ---- PG Server ----

export class PGServer implements ProtocolServerInstance {
    name: ProtocolType = 'postgresql';
    server: net.Server | null = null;
    port: number;
    connections: number = 0;
    private host: string;
    private store: DocumentStore;
    private translator: SQLTranslator;
    private joinEngine: JoinEngine;
    private activeConnections: Set<net.Socket> = new Set();
    private timeoutMs: number;
    private apiKey?: string;
    private authenticatedSockets: WeakSet<object> = new WeakSet();
    private metrics?: MetricsCollector;
    // Per-connection Extended Query Protocol state (garbage-collected
    // automatically alongside the socket — no explicit cleanup needed).
    private preparedStatements: WeakMap<net.Socket, Map<string, PreparedStatement>> = new WeakMap();
    private portals: WeakMap<net.Socket, Map<string, Portal>> = new WeakMap();

    constructor(options: {
        store: DocumentStore;
        port?: number;
        host?: string;
        timeoutMs?: number;
        apiKey?: string;
        metrics?: MetricsCollector;
    }) {
        this.store = options.store;
        this.port = options.port || 5432;
        this.host = options.host || '0.0.0.0';
        this.timeoutMs = options.timeoutMs || 30000;
        this.apiKey = options.apiKey;
        this.metrics = options.metrics;
        this.translator = new SQLTranslator({ dialect: 'PostgreSQL' }); // explicit — matches this server's actual protocol
        this.joinEngine = new JoinEngine();
    }

    async start(): Promise<void> {
        if (this.server) return;

        return new Promise((resolve, reject) => {
            this.server = net.createServer((socket) => this.handleConnection(socket));
            this.server.on('error', reject);
            this.server.listen(this.port, this.host, () => {
                console.log(`[PlugPort] PostgreSQL protocol listening on ${this.host}:${this.port}`);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.server) return;

        // Close all active connections
        for (const socket of this.activeConnections) {
            socket.destroy();
        }
        this.activeConnections.clear();

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
            this.activeConnections.delete(socket);
            this.connections--;
            this.metrics?.connectionClosed('wire');
        };

        let buffer = Buffer.alloc(0);
        let startupComplete = false;

        socket.on('data', async (data) => {
            buffer = Buffer.concat([buffer, data]);

            try {
                if (!startupComplete) {
                    // Handle startup sequence
                    if (buffer.length >= 8) {
                        const length = buffer.readInt32BE(0);
                        const protocolVersion = buffer.readInt32BE(4);

                        if (protocolVersion === 80877103) {
                            // SSLRequest — decline with 'N'
                            socket.write(Buffer.from('N'));
                            buffer = buffer.subarray(length);
                            return;
                        }

                        if (buffer.length >= length) {
                            // Parse startup parameters (unused beyond auth negotiation, but must be consumed)
                            this.parseStartupParams(buffer.subarray(8, length));
                            buffer = buffer.subarray(length);
                            startupComplete = true;

                            if (this.apiKey) {
                                this.sendAuthCleartextRequest(socket);
                            } else {
                                // No API key configured — dev mode, no auth required
                                this.authenticatedSockets.add(socket);
                                this.sendStartupResponse(socket);
                            }
                        }
                    }
                    return;
                }

                // Process messages
                while (buffer.length >= 5) {
                    const msgType = buffer[0];
                    const msgLength = buffer.readInt32BE(1);

                    if (buffer.length < msgLength + 1) break; // Incomplete message

                    const msgBody = buffer.subarray(5, msgLength + 1);
                    buffer = buffer.subarray(msgLength + 1);

                    await this.handleMessage(socket, msgType, msgBody);
                }
            } catch (err: any) {
                this.sendError(socket, err.message);
                this.sendReadyForQuery(socket);
            }
        });

        socket.on('close', onDisconnect);
        socket.on('error', onDisconnect);
    }

    // ---- Message Handler ----

    private async handleMessage(socket: net.Socket, msgType: number, body: Buffer): Promise<void> {
        if (msgType === PG_MSG.PASSWORD) {
            const password = body.toString('utf-8').replace(/\0$/, '');
            if (this.apiKey && safeCompare(password, this.apiKey)) {
                this.authenticatedSockets.add(socket);
                this.sendStartupResponse(socket);
            } else {
                this.sendAuthFailure(socket);
            }
            return;
        }

        if (this.apiKey && !this.authenticatedSockets.has(socket)) {
            this.sendAuthFailure(socket);
            return;
        }

        switch (msgType) {
            case PG_MSG.QUERY: {
                // Simple query protocol
                const sql = body.toString('utf-8').replace(/\0$/, '').trim();

                if (!sql) {
                    this.sendEmptyQuery(socket);
                    this.sendReadyForQuery(socket);
                    return;
                }

                const startTime = Date.now();
                let success = true;
                try {
                    const translated = this.translator.translate(sql);

                    let timeoutId: ReturnType<typeof setTimeout>;
                    const timeoutPromise = new Promise<never>((_, reject) => {
                        timeoutId = setTimeout(() => reject(new Error('SQL execution timeout')), this.timeoutMs);
                    });

                    try {
                        await Promise.race([
                            this.executeTranslated(socket, translated, sql),
                            timeoutPromise
                        ]);
                    } finally {
                        clearTimeout(timeoutId!);
                    }
                } catch (err: any) {
                    success = false;
                    this.sendError(socket, err.message);
                }

                this.metrics?.recordRequest('QUERY', 'wire', Date.now() - startTime, success);
                this.sendReadyForQuery(socket);
                break;
            }

            case PG_MSG.TERMINATE: {
                socket.end();
                break;
            }

            case PG_MSG.SYNC: {
                this.sendReadyForQuery(socket);
                break;
            }

            // Extended query protocol
            case PG_MSG.PARSE: {
                const { statementName, query } = this.parseParseMessage(body);
                this.getStatements(socket).set(statementName, { sql: query });
                this.sendParseComplete(socket);
                break;
            }
            case PG_MSG.BIND: {
                const bind = this.parseBindMessage(body);
                this.getPortals(socket).set(bind.portalName, {
                    statementName: bind.statementName,
                    paramValues: bind.paramValues,
                });
                this.sendBindComplete(socket);
                break;
            }
            case PG_MSG.DESCRIBE: {
                // Column shapes aren't known until a query actually runs
                // (documents are schemaless) — NoData is the honest answer
                // here; the real RowDescription still goes out with the
                // results once Execute runs the query.
                this.sendNoData(socket);
                break;
            }
            case PG_MSG.EXECUTE: {
                const { portalName } = this.parseExecuteMessage(body);
                const portal = this.getPortals(socket).get(portalName);
                if (!portal) {
                    this.sendError(socket, `portal "${portalName}" does not exist`);
                    break;
                }
                const statement = this.getStatements(socket).get(portal.statementName);
                if (!statement) {
                    this.sendError(socket, `prepared statement "${portal.statementName}" does not exist`);
                    break;
                }

                const sql = this.substituteParams(statement.sql, portal.paramValues);
                if (!sql.trim()) {
                    this.sendEmptyQuery(socket);
                    break;
                }

                const startTime = Date.now();
                let success = true;
                try {
                    const translated = this.translator.translate(sql);

                    let timeoutId: ReturnType<typeof setTimeout>;
                    const timeoutPromise = new Promise<never>((_, reject) => {
                        timeoutId = setTimeout(() => reject(new Error('SQL execution timeout')), this.timeoutMs);
                    });

                    try {
                        await Promise.race([
                            this.executeTranslated(socket, translated, sql),
                            timeoutPromise
                        ]);
                    } finally {
                        clearTimeout(timeoutId!);
                    }
                } catch (err: any) {
                    success = false;
                    this.sendError(socket, err.message);
                }

                this.metrics?.recordRequest('EXECUTE', 'wire', Date.now() - startTime, success);
                break;
            }
            case PG_MSG.CLOSE: {
                const { kind, name } = this.parseCloseMessage(body);
                if (kind === 'S') this.getStatements(socket).delete(name);
                else this.getPortals(socket).delete(name);
                this.sendCloseComplete(socket);
                break;
            }

            default:
                // Unknown message — ignore
                break;
        }
    }

    // ---- SQL Execution ----

    private async executeTranslated(socket: net.Socket, query: TranslatedQuery, originalSql: string): Promise<void> {
        switch (query.type) {
            case 'find': {
                const result = await this.store.find(
                    query.collection!,
                    query.filter || {},
                    { sort: query.sort, limit: query.limit, skip: query.skip },
                );
                const docs = result.cursor.firstBatch;
                this.sendResultSet(socket, docs, `SELECT ${docs.length}`);
                break;
            }

            case 'insert': {
                let insertedCount = 0;
                for (const doc of query.documents || []) {
                    await this.store.insert(query.collection!, [doc] as any);
                    insertedCount++;
                }
                this.sendCommandComplete(socket, `INSERT 0 ${insertedCount}`);
                break;
            }

            case 'update': {
                const updateResult = await this.store.updateMany(
                    query.collection!,
                    query.filter || {},
                    query.update as any || { $set: {} },
                );
                this.sendCommandComplete(socket, `UPDATE ${updateResult.modifiedCount}`);
                break;
            }

            case 'delete': {
                const deleteResult = await this.store.deleteMany(
                    query.collection!,
                    query.filter || {},
                );
                this.sendCommandComplete(socket, `DELETE ${deleteResult.deletedCount}`);
                break;
            }

            case 'createCollection': {
                await this.store.getOrCreateCollection(query.collection!);
                this.sendCommandComplete(socket, 'CREATE TABLE');
                break;
            }

            case 'dropCollection': {
                await this.store.dropCollection(query.collection!);
                this.sendCommandComplete(socket, 'DROP TABLE');
                break;
            }

            case 'createIndex': {
                await this.store.createIndex(
                    query.collection!,
                    query.indexField!,
                    query.indexUnique ?? false,
                );
                this.sendCommandComplete(socket, 'CREATE INDEX');
                break;
            }

            case 'listCollections': {
                const collections = await this.store.listCollections();
                const docs = collections.map(c => ({
                    _id: c.name,
                    table_name: c.name,
                    document_count: c.documentCount,
                    index_count: c.indexes.length,
                })) as any[];
                this.sendResultSet(socket, docs, `SELECT ${docs.length}`);
                break;
            }

            case 'count': {
                const countResult = await this.store.find(
                    query.collection!,
                    query.filter || {},
                    {},
                );
                const countDocs = [{ _id: '0', count: countResult.cursor.firstBatch.length }] as any[];
                this.sendResultSet(socket, countDocs, 'SELECT 1');
                break;
            }

            case 'join': {
                const joinResult = await this.joinEngine.execute(query.joinPlan!, this.store);
                const joinDocs = joinResult.documents.map((doc, i) => ({
                    _id: String(i),
                    ...doc,
                })) as DocumentWithId[];
                this.sendResultSet(socket, joinDocs, `SELECT ${joinDocs.length}`);
                break;
            }

            case 'aggregate': {
                const aggResult = await this.store.find(
                    query.collection!,
                    query.filter || {},
                    {},
                );
                const aggDocs = executeAggregation(
                    aggResult.cursor.firstBatch,
                    query.aggregation!,
                );
                this.sendResultSet(socket, aggDocs as any[], `SELECT ${aggDocs.length}`);
                break;
            }

            case 'noop': {
                this.sendNotice(socket, query.message || 'OK');
                this.sendCommandComplete(socket, 'SET');
                break;
            }

            case 'showDatabases': {
                const dbDocs = [{ _id: '0', database: 'plugport' }] as any[];
                this.sendResultSet(socket, dbDocs, 'SELECT 1');
                break;
            }

            case 'use': {
                this.sendCommandComplete(socket, 'SET');
                break;
            }

            default:
                this.sendError(socket, `Unsupported query type: ${query.type}`);
        }
    }

    // ---- Extended Query Protocol: per-connection statement/portal state ----

    private getStatements(socket: net.Socket): Map<string, PreparedStatement> {
        let map = this.preparedStatements.get(socket);
        if (!map) {
            map = new Map();
            this.preparedStatements.set(socket, map);
        }
        return map;
    }

    private getPortals(socket: net.Socket): Map<string, Portal> {
        let map = this.portals.get(socket);
        if (!map) {
            map = new Map();
            this.portals.set(socket, map);
        }
        return map;
    }

    // ---- Extended Query Protocol: message parsing ----

    private readCString(buf: Buffer, offset: number): string {
        const nullIdx = buf.indexOf(0, offset);
        return buf.toString('utf-8', offset, nullIdx === -1 ? buf.length : nullIdx);
    }

    private parseParseMessage(body: Buffer): { statementName: string; query: string } {
        const statementName = this.readCString(body, 0);
        let offset = Buffer.byteLength(statementName, 'utf-8') + 1;
        const query = this.readCString(body, offset);
        // Remaining bytes (Int16 param count + Int32 OIDs per param) are
        // intentionally unread — substituteParams() infers numeric-vs-string
        // from each bound value's text representation instead of relying on
        // declared parameter type OIDs.
        return { statementName, query };
    }

    private parseBindMessage(body: Buffer): {
        portalName: string;
        statementName: string;
        paramValues: (Buffer | null)[];
    } {
        let offset = 0;
        const portalName = this.readCString(body, offset);
        offset += Buffer.byteLength(portalName, 'utf-8') + 1;
        const statementName = this.readCString(body, offset);
        offset += Buffer.byteLength(statementName, 'utf-8') + 1;

        // Parameter format codes — read only to advance past them correctly;
        // not retained. substituteParams() decodes every bound value as
        // UTF-8 text regardless of format (see its doc comment).
        const numParamFormats = body.readInt16BE(offset); offset += 2;
        offset += numParamFormats * 2;

        const numParams = body.readInt16BE(offset); offset += 2;
        const paramValues: (Buffer | null)[] = [];
        for (let i = 0; i < numParams; i++) {
            const len = body.readInt32BE(offset); offset += 4;
            if (len === -1) {
                paramValues.push(null);
            } else {
                paramValues.push(body.subarray(offset, offset + len));
                offset += len;
            }
        }

        // Result format codes (trailing Int16 count + codes) intentionally
        // unread — results are always sent as text (format code 0), matching
        // the Simple Query path's existing RowDescription/DataRow encoding.

        return { portalName, statementName, paramValues };
    }

    private parseExecuteMessage(body: Buffer): { portalName: string } {
        const portalName = this.readCString(body, 0);
        return { portalName };
    }

    private parseCloseMessage(body: Buffer): { kind: 'S' | 'P'; name: string } {
        const kind = body[0] === 'S'.charCodeAt(0) ? 'S' : 'P';
        const name = this.readCString(body, 1);
        return { kind, name };
    }

    /**
     * Substitutes $1, $2, ... placeholders in a prepared statement's SQL
     * with the actual bound parameter values from Bind, producing plain
     * SQL text that SQLTranslator can parse the same way it parses a
     * Simple Query. NULL binds become the SQL NULL keyword; values that
     * look like bare numbers are inserted unquoted, everything else is
     * single-quoted (with embedded quotes escaped).
     *
     * Every bound value is decoded as UTF-8 text regardless of the format
     * code Bind declared for it — binary-format parameters (int4/int8/
     * float8/bool binary wire encodings) aren't decoded per their true
     * binary representation, only as best-effort UTF-8 text. Most drivers
     * default to text format, so this covers the common case.
     */
    private substituteParams(sql: string, paramValues: (Buffer | null)[]): string {
        return sql.replace(/\$(\d+)/g, (match, numStr) => {
            const idx = parseInt(numStr, 10) - 1;
            if (idx < 0 || idx >= paramValues.length) return match;

            const raw = paramValues[idx];
            if (raw === null) return 'NULL';

            // Both text and binary formats are decoded as UTF-8 text here —
            // see the doc comment above for why binary is best-effort only.
            const text = raw.toString('utf-8');
            if (/^-?\d+(\.\d+)?$/.test(text)) return text;
            return `'${text.replace(/'/g, "''")}'`;
        });
    }

    // ---- PG Wire Protocol Message Builders ----

    private parseStartupParams(buf: Buffer): Record<string, string> {
        const params: Record<string, string> = {};
        const str = buf.toString('utf-8');
        const parts = str.split('\0').filter(s => s.length > 0);
        for (let i = 0; i < parts.length - 1; i += 2) {
            params[parts[i]] = parts[i + 1];
        }
        return params;
    }

    private sendAuthCleartextRequest(socket: net.Socket): void {
        const msg = Buffer.alloc(9);
        msg[0] = PG_MSG.AUTH;
        msg.writeInt32BE(8, 1);
        msg.writeInt32BE(3, 5); // AuthenticationCleartextPassword = 3
        socket.write(msg);
    }

    private sendAuthFailure(socket: net.Socket): void {
        // ErrorResponse: severity FATAL, code 28P01 (invalid_password), then close
        const fields = Buffer.concat([
            Buffer.from('S'), Buffer.from('FATAL\0'),
            Buffer.from('C'), Buffer.from('28P01\0'),
            Buffer.from('M'), Buffer.from('password authentication failed\0'),
            Buffer.from([0]),
        ]);
        const msg = Buffer.alloc(5 + fields.length);
        msg[0] = PG_MSG.ERROR;
        msg.writeInt32BE(4 + fields.length, 1);
        fields.copy(msg, 5);
        socket.write(msg);
        socket.end();
    }

    private sendStartupResponse(socket: net.Socket): void {
        // AuthenticationOk
        const authOk = Buffer.alloc(9);
        authOk[0] = PG_MSG.AUTH;
        authOk.writeInt32BE(8, 1);
        authOk.writeInt32BE(0, 5); // AuthenticationOk = 0
        socket.write(authOk);

        // ParameterStatus messages
        this.sendParameterStatus(socket, 'server_version', '15.0 (PlugPort)');
        this.sendParameterStatus(socket, 'server_encoding', 'UTF8');
        this.sendParameterStatus(socket, 'client_encoding', 'UTF8');
        this.sendParameterStatus(socket, 'DateStyle', 'ISO, MDY');
        this.sendParameterStatus(socket, 'TimeZone', 'UTC');
        this.sendParameterStatus(socket, 'integer_datetimes', 'on');
        this.sendParameterStatus(socket, 'standard_conforming_strings', 'on');

        // BackendKeyData
        const keyData = Buffer.alloc(13);
        keyData[0] = PG_MSG.BACKEND_KEY;
        keyData.writeInt32BE(12, 1);
        keyData.writeInt32BE(process.pid, 5);    // Process ID
        keyData.writeUInt32BE(0xDEADBEEF, 9);    // Secret key (opaque 32-bit value; unsigned write since 0xDEADBEEF exceeds the signed int32 range)
        socket.write(keyData);

        // ReadyForQuery
        this.sendReadyForQuery(socket);
    }

    private sendParameterStatus(socket: net.Socket, name: string, value: string): void {
        const nameBuf = Buffer.from(name + '\0', 'utf-8');
        const valBuf = Buffer.from(value + '\0', 'utf-8');
        const length = 4 + nameBuf.length + valBuf.length;

        const msg = Buffer.alloc(1 + length);
        msg[0] = PG_MSG.PARAM_STATUS;
        msg.writeInt32BE(length, 1);
        nameBuf.copy(msg, 5);
        valBuf.copy(msg, 5 + nameBuf.length);
        socket.write(msg);
    }

    private sendReadyForQuery(socket: net.Socket): void {
        const msg = Buffer.alloc(6);
        msg[0] = PG_MSG.READY;
        msg.writeInt32BE(5, 1);
        msg[5] = 'I'.charCodeAt(0); // Idle
        socket.write(msg);
    }

    private sendResultSet(socket: net.Socket, docs: DocumentWithId[], tag: string): void {
        if (docs.length === 0) {
            // Empty result — send RowDescription with no columns, then CommandComplete
            this.sendEmptyRowDesc(socket);
            this.sendCommandComplete(socket, tag);
            return;
        }

        // Determine columns from first document
        const columns = Object.keys(docs[0]).filter(k => k !== '_id');
        if (columns.length === 0) {
            columns.push('_id');
        }

        // RowDescription
        this.sendRowDescription(socket, columns);

        // DataRows
        for (const doc of docs) {
            this.sendDataRow(socket, columns, doc);
        }

        // CommandComplete
        this.sendCommandComplete(socket, tag);
    }

    private sendRowDescription(socket: net.Socket, columns: string[]): void {
        // Calculate total message length
        let bodyLen = 2; // Int16 number of fields
        for (const col of columns) {
            bodyLen += Buffer.byteLength(col, 'utf-8') + 1; // column name + null terminator
            bodyLen += 18; // table OID (4) + column attr (2) + type OID (4) + type size (2) + type modifier (4) + format code (2)
        }

        const msg = Buffer.alloc(1 + 4 + bodyLen);
        let offset = 0;

        msg[offset++] = PG_MSG.ROW_DESC;
        msg.writeInt32BE(4 + bodyLen, offset); offset += 4;
        msg.writeInt16BE(columns.length, offset); offset += 2;

        for (const col of columns) {
            const nameBytes = Buffer.from(col + '\0', 'utf-8');
            nameBytes.copy(msg, offset); offset += nameBytes.length;
            msg.writeInt32BE(0, offset); offset += 4;    // Table OID
            msg.writeInt16BE(0, offset); offset += 2;    // Column attr number
            msg.writeInt32BE(25, offset); offset += 4;   // Data type OID (25 = text)
            msg.writeInt16BE(-1, offset); offset += 2;   // Data type size
            msg.writeInt32BE(-1, offset); offset += 4;   // Type modifier
            msg.writeInt16BE(0, offset); offset += 2;    // Format code (0 = text)
        }

        socket.write(msg);
    }

    private sendDataRow(socket: net.Socket, columns: string[], doc: Record<string, unknown>): void {
        // Serialize all column values as text
        const values: Buffer[] = [];
        for (const col of columns) {
            const val = doc[col];
            if (val === null || val === undefined) {
                values.push(Buffer.alloc(0)); // Will be marked as -1 (null)
            } else {
                const text = typeof val === 'object' ? JSON.stringify(val) : String(val);
                values.push(Buffer.from(text, 'utf-8'));
            }
        }

        // Calculate body size
        let bodyLen = 2; // Int16 number of columns
        for (let i = 0; i < columns.length; i++) {
            const val = doc[columns[i]];
            if (val === null || val === undefined) {
                bodyLen += 4; // -1 for null
            } else {
                bodyLen += 4 + values[i].length; // Int32 length + data
            }
        }

        const msg = Buffer.alloc(1 + 4 + bodyLen);
        let offset = 0;

        msg[offset++] = PG_MSG.DATA_ROW;
        msg.writeInt32BE(4 + bodyLen, offset); offset += 4;
        msg.writeInt16BE(columns.length, offset); offset += 2;

        for (let i = 0; i < columns.length; i++) {
            const val = doc[columns[i]];
            if (val === null || val === undefined) {
                msg.writeInt32BE(-1, offset); offset += 4; // NULL
            } else {
                msg.writeInt32BE(values[i].length, offset); offset += 4;
                values[i].copy(msg, offset); offset += values[i].length;
            }
        }

        socket.write(msg);
    }

    private sendEmptyRowDesc(socket: net.Socket): void {
        const msg = Buffer.alloc(7);
        msg[0] = PG_MSG.ROW_DESC;
        msg.writeInt32BE(6, 1);
        msg.writeInt16BE(0, 5);
        socket.write(msg);
    }

    private sendCommandComplete(socket: net.Socket, tag: string): void {
        const tagBuf = Buffer.from(tag + '\0', 'utf-8');
        const msg = Buffer.alloc(1 + 4 + tagBuf.length);
        msg[0] = PG_MSG.CMD_COMPLETE;
        msg.writeInt32BE(4 + tagBuf.length, 1);
        tagBuf.copy(msg, 5);
        socket.write(msg);
    }

    private sendError(socket: net.Socket, message: string): void {
        // ErrorResponse: severity, code, message
        const fields = Buffer.concat([
            Buffer.from('S'), Buffer.from('ERROR\0'),
            Buffer.from('V'), Buffer.from('ERROR\0'),
            Buffer.from('C'), Buffer.from('42000\0'),   // Syntax error
            Buffer.from('M'), Buffer.from(message + '\0'),
            Buffer.from('\0'), // Terminator
        ]);

        const msg = Buffer.alloc(1 + 4 + fields.length);
        msg[0] = PG_MSG.ERROR;
        msg.writeInt32BE(4 + fields.length, 1);
        fields.copy(msg, 5);
        socket.write(msg);
    }

    private sendNotice(socket: net.Socket, message: string): void {
        const fields = Buffer.concat([
            Buffer.from('S'), Buffer.from('NOTICE\0'),
            Buffer.from('V'), Buffer.from('NOTICE\0'),
            Buffer.from('C'), Buffer.from('00000\0'),
            Buffer.from('M'), Buffer.from(message + '\0'),
            Buffer.from('\0'),
        ]);

        const msg = Buffer.alloc(1 + 4 + fields.length);
        msg[0] = PG_MSG.NOTICE;
        msg.writeInt32BE(4 + fields.length, 1);
        fields.copy(msg, 5);
        socket.write(msg);
    }

    private sendEmptyQuery(socket: net.Socket): void {
        const msg = Buffer.alloc(5);
        msg[0] = PG_MSG.EMPTY_QUERY;
        msg.writeInt32BE(4, 1);
        socket.write(msg);
    }

    private sendParseComplete(socket: net.Socket): void {
        const msg = Buffer.alloc(5);
        msg[0] = PG_MSG.PARSE_COMPLETE;
        msg.writeInt32BE(4, 1);
        socket.write(msg);
    }

    private sendBindComplete(socket: net.Socket): void {
        const msg = Buffer.alloc(5);
        msg[0] = PG_MSG.BIND_COMPLETE;
        msg.writeInt32BE(4, 1);
        socket.write(msg);
    }

    private sendNoData(socket: net.Socket): void {
        const msg = Buffer.alloc(5);
        msg[0] = PG_MSG.NO_DATA;
        msg.writeInt32BE(4, 1);
        socket.write(msg);
    }

    private sendCloseComplete(socket: net.Socket): void {
        const msg = Buffer.alloc(5);
        msg[0] = PG_MSG.CLOSE_COMPLETE;
        msg.writeInt32BE(4, 1);
        socket.write(msg);
    }
}
