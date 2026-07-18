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
import { DocumentStore } from '../storage/document-store.js';
import { SQLTranslator, type TranslatedQuery } from './sql-translator.js';
import { JoinEngine } from './join-engine.js';
import type { ProtocolServerInstance } from './protocol-manager.js';
import type { ProtocolType, DocumentWithId } from '@plugport/shared';

// ---- PG Message Types ----

const PG_MSG = {
    // Frontend (client → server)
    QUERY: 'Q'.charCodeAt(0),          // Simple query
    PARSE: 'P'.charCodeAt(0),          // Extended query: parse
    BIND: 'B'.charCodeAt(0),           // Extended query: bind
    DESCRIBE: 'D'.charCodeAt(0),       // Describe
    EXECUTE: 'E'.charCodeAt(0),        // Execute
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

    constructor(options: {
        store: DocumentStore;
        port?: number;
        host?: string;
        timeoutMs?: number;
    }) {
        this.store = options.store;
        this.port = options.port || 5432;
        this.host = options.host || '0.0.0.0';
        this.timeoutMs = options.timeoutMs || 30000;
        this.translator = new SQLTranslator();
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
                            // Parse startup parameters
                            const params = this.parseStartupParams(buffer.subarray(8, length));
                            buffer = buffer.subarray(length);
                            startupComplete = true;

                            // Send authentication OK + parameters + ready
                            this.sendStartupResponse(socket, params);
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

        socket.on('close', () => {
            this.activeConnections.delete(socket);
            this.connections--;
        });

        socket.on('error', () => {
            this.activeConnections.delete(socket);
            this.connections--;
        });
    }

    // ---- Message Handler ----

    private async handleMessage(socket: net.Socket, msgType: number, body: Buffer): Promise<void> {
        switch (msgType) {
            case PG_MSG.QUERY: {
                // Simple query protocol
                const sql = body.toString('utf-8').replace(/\0$/, '').trim();

                if (!sql) {
                    this.sendEmptyQuery(socket);
                    this.sendReadyForQuery(socket);
                    return;
                }

                try {
                    const translated = this.translator.translate(sql);
                    
                    const timeoutPromise = new Promise<never>((_, reject) => {
                        setTimeout(() => reject(new Error('SQL execution timeout')), this.timeoutMs);
                    });

                    await Promise.race([
                        this.executeTranslated(socket, translated, sql),
                        timeoutPromise
                    ]);
                } catch (err: any) {
                    this.sendError(socket, err.message);
                }

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

            // Extended query protocol (simplified)
            case PG_MSG.PARSE: {
                this.sendParseComplete(socket);
                break;
            }
            case PG_MSG.BIND: {
                this.sendBindComplete(socket);
                break;
            }
            case PG_MSG.DESCRIBE: {
                this.sendNoData(socket);
                break;
            }
            case PG_MSG.EXECUTE: {
                this.sendCommandComplete(socket, 'SELECT 0');
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
                    await this.store.insert(query.collection!, doc as any);
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
                const aggDocs = this.executeAggregation(
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

    // ---- Aggregation Execution ----

    private executeAggregation(
        docs: DocumentWithId[],
        plan: import('./sql-translator.js').AggregationPlan,
    ): Record<string, unknown>[] {
        // Group documents
        const groups = new Map<string, DocumentWithId[]>();

        if (plan.groupBy.length === 0) {
            // No GROUP BY — entire result is one group
            groups.set('__all__', docs);
        } else {
            for (const doc of docs) {
                const key = plan.groupBy.map(f => String(doc[f] ?? 'null')).join('|');
                const group = groups.get(key);
                if (group) group.push(doc);
                else groups.set(key, [doc]);
            }
        }

        // Compute aggregates per group
        const results: Record<string, unknown>[] = [];

        for (const [, groupDocs] of groups) {
            const row: Record<string, unknown> = {};

            // Add GROUP BY columns
            if (plan.groupBy.length > 0 && groupDocs.length > 0) {
                for (const field of plan.groupBy) {
                    row[field] = groupDocs[0][field];
                }
            }

            // Compute aggregate functions
            for (const agg of plan.aggregates) {
                switch (agg.type) {
                    case 'COUNT':
                        row[agg.alias] = groupDocs.length;
                        break;
                    case 'SUM': {
                        let sum = 0;
                        for (const d of groupDocs) {
                            const v = Number(d[agg.field]);
                            if (!isNaN(v)) sum += v;
                        }
                        row[agg.alias] = sum;
                        break;
                    }
                    case 'AVG': {
                        let s = 0, c = 0;
                        for (const d of groupDocs) {
                            const v = Number(d[agg.field]);
                            if (!isNaN(v)) { s += v; c++; }
                        }
                        row[agg.alias] = c > 0 ? s / c : null;
                        break;
                    }
                    case 'MIN': {
                        let min: number | null = null;
                        for (const d of groupDocs) {
                            const v = Number(d[agg.field]);
                            if (!isNaN(v) && (min === null || v < min)) min = v;
                        }
                        row[agg.alias] = min;
                        break;
                    }
                    case 'MAX': {
                        let max: number | null = null;
                        for (const d of groupDocs) {
                            const v = Number(d[agg.field]);
                            if (!isNaN(v) && (max === null || v > max)) max = v;
                        }
                        row[agg.alias] = max;
                        break;
                    }
                }
            }

            results.push(row);
        }

        return results;
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

    private sendStartupResponse(socket: net.Socket, _params: Record<string, string>): void {
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
        keyData.writeInt32BE(0xDEADBEEF, 9);     // Secret key
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
}
