// PlugPort MySQL Wire Protocol Server
// Implements the MySQL client/server protocol.
// Accepts connections from mysql2, TypeORM, Sequelize, Knex, mysql-cli.
// Translates SQL → DocumentStore operations via SQLTranslator + JoinEngine.
//
// Protocol reference: https://dev.mysql.com/doc/dev/mysql-server/latest/
//
// Message flow:
//   Server → Handshake (with auth challenge)
//   Client → HandshakeResponse (auth)
//   Server → OK/ERR
//   Client → COM_QUERY (SQL text)
//   Server → Column definitions → Rows → EOF/OK

import net from 'net';
import crypto from 'crypto';
import { DocumentStore } from '../storage/document-store.js';
import { SQLTranslator, type TranslatedQuery } from './sql-translator.js';
import { JoinEngine } from './join-engine.js';
import type { ProtocolServerInstance } from './protocol-manager.js';
import type { ProtocolType, DocumentWithId } from '@plugport/shared';

// ---- MySQL Command Codes ----

const COM = {
    QUIT: 0x01,
    INIT_DB: 0x02,
    QUERY: 0x03,
    FIELD_LIST: 0x04,
    PING: 0x0e,
    STMT_PREPARE: 0x16,
    STMT_EXECUTE: 0x17,
    STMT_CLOSE: 0x19,
} as const;

// ---- MySQL Server ----

export class MySQLServer implements ProtocolServerInstance {
    name: ProtocolType = 'mysql';
    server: net.Server | null = null;
    port: number;
    connections: number = 0;
    private host: string;
    private store: DocumentStore;
    private translator: SQLTranslator;
    private joinEngine: JoinEngine;
    private activeConnections: Set<net.Socket> = new Set();
    private connectionIdCounter: number = 1;
    private timeoutMs: number;

    constructor(options: {
        store: DocumentStore;
        port?: number;
        host?: string;
        timeoutMs?: number;
    }) {
        this.store = options.store;
        this.port = options.port || 3306;
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
                console.log(`[PlugPort] MySQL protocol listening on ${this.host}:${this.port}`);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.server) return;

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

        const connectionId = this.connectionIdCounter++;
        let buffer = Buffer.alloc(0);
        let handshakeComplete = false;
        let sequenceId = 0;

        // Send initial handshake
        const authChallenge = crypto.randomBytes(20);
        this.sendHandshake(socket, connectionId, authChallenge);
        sequenceId = 1;

        socket.on('data', async (data) => {
            buffer = Buffer.concat([buffer, data]);

            try {
                while (buffer.length >= 4) {
                    // MySQL packet header: 3-byte length + 1-byte sequence ID
                    const payloadLength = buffer[0] | (buffer[1] << 8) | (buffer[2] << 16);
                    const _seqId = buffer[3];

                    if (buffer.length < 4 + payloadLength) break; // Incomplete packet

                    const payload = buffer.subarray(4, 4 + payloadLength);
                    buffer = buffer.subarray(4 + payloadLength);

                    if (!handshakeComplete) {
                        // Handshake response — just accept
                        handshakeComplete = true;
                        sequenceId = _seqId + 1;
                        this.sendOK(socket, sequenceId);
                        continue;
                    }

                    sequenceId = _seqId + 1;
                    await this.handleCommand(socket, payload, sequenceId);
                }
            } catch (err: any) {
                this.sendERR(socket, sequenceId, err.message);
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

    // ---- Command Handler ----

    private async handleCommand(socket: net.Socket, payload: Buffer, seqId: number): Promise<void> {
        const commandType = payload[0];

        switch (commandType) {
            case COM.QUERY: {
                const sql = payload.subarray(1).toString('utf-8').trim();

                try {
                    const translated = this.translator.translate(sql);

                    let timeoutId: ReturnType<typeof setTimeout>;
                    const timeoutPromise = new Promise<never>((_, reject) => {
                        timeoutId = setTimeout(() => reject(new Error('SQL execution timeout')), this.timeoutMs);
                    });

                    try {
                        await Promise.race([
                            this.executeTranslated(socket, translated, seqId),
                            timeoutPromise
                        ]);
                    } finally {
                        clearTimeout(timeoutId!);
                    }
                } catch (err: any) {
                    this.sendERR(socket, seqId, err.message);
                }
                break;
            }

            case COM.PING: {
                this.sendOK(socket, seqId);
                break;
            }

            case COM.QUIT: {
                this.sendOK(socket, seqId);
                socket.end();
                break;
            }

            case COM.INIT_DB: {
                // USE database — acknowledge
                this.sendOK(socket, seqId);
                break;
            }

            default: {
                this.sendERR(socket, seqId, `Unsupported command: 0x${commandType.toString(16)}`);
            }
        }
    }

    // ---- SQL Execution ----

    private async executeTranslated(socket: net.Socket, query: TranslatedQuery, seqId: number): Promise<void> {
        switch (query.type) {
            case 'find': {
                const result = await this.store.find(
                    query.collection!,
                    query.filter || {},
                    { sort: query.sort, limit: query.limit, skip: query.skip },
                );
                this.sendResultSet(socket, result.cursor.firstBatch, seqId);
                break;
            }

            case 'insert': {
                let count = 0;
                for (const doc of query.documents || []) {
                    await this.store.insert(query.collection!, doc as any);
                    count++;
                }
                this.sendOK(socket, seqId, count);
                break;
            }

            case 'update': {
                const updateResult = await this.store.updateMany(
                    query.collection!,
                    query.filter || {},
                    query.update || { $set: {} },
                );
                this.sendOK(socket, seqId, updateResult.modifiedCount);
                break;
            }

            case 'delete': {
                const deleteResult = await this.store.deleteMany(
                    query.collection!,
                    query.filter || {},
                );
                this.sendOK(socket, seqId, deleteResult.deletedCount);
                break;
            }

            case 'createCollection': {
                await this.store.getOrCreateCollection(query.collection!);
                this.sendOK(socket, seqId);
                break;
            }

            case 'dropCollection': {
                await this.store.dropCollection(query.collection!);
                this.sendOK(socket, seqId);
                break;
            }

            case 'createIndex': {
                await this.store.createIndex(
                    query.collection!,
                    query.indexField!,
                    query.indexUnique ?? false,
                );
                this.sendOK(socket, seqId);
                break;
            }

            case 'listCollections': {
                const collections = await this.store.listCollections();
                const docs = collections.map(c => ({
                    _id: c.name,
                    Tables_in_plugport: c.name,
                })) as any[];
                this.sendResultSet(socket, docs, seqId);
                break;
            }

            case 'join': {
                const joinResult = await this.joinEngine.execute(query.joinPlan!, this.store);
                const joinDocs = joinResult.documents.map((doc, i) => ({
                    _id: String(i),
                    ...doc,
                })) as DocumentWithId[];
                this.sendResultSet(socket, joinDocs, seqId);
                break;
            }

            case 'noop':
            case 'use':
            case 'showDatabases': {
                this.sendOK(socket, seqId);
                break;
            }

            default:
                this.sendERR(socket, seqId, `Unsupported query type: ${query.type}`);
        }
    }

    // ---- MySQL Packet Builders ----

    private writePacket(socket: net.Socket, payload: Buffer, seqId: number): void {
        const header = Buffer.alloc(4);
        header[0] = payload.length & 0xff;
        header[1] = (payload.length >> 8) & 0xff;
        header[2] = (payload.length >> 16) & 0xff;
        header[3] = seqId & 0xff;
        socket.write(Buffer.concat([header, payload]));
    }

    private sendHandshake(socket: net.Socket, connectionId: number, authChallenge: Buffer): void {
        const serverVersion = Buffer.from('8.0.0-PlugPort\0', 'utf-8');
        const authPluginName = Buffer.from('mysql_native_password\0', 'utf-8');

        const parts: Buffer[] = [];
        // Protocol version
        parts.push(Buffer.from([10]));
        // Server version
        parts.push(serverVersion);
        // Connection ID (4 bytes LE)
        const connIdBuf = Buffer.alloc(4);
        connIdBuf.writeUInt32LE(connectionId);
        parts.push(connIdBuf);
        // Auth-data-1 (first 8 bytes of challenge)
        parts.push(authChallenge.subarray(0, 8));
        // Filler
        parts.push(Buffer.from([0x00]));
        // Capability flags (lower 2 bytes)
        parts.push(Buffer.from([0xff, 0xf7]));
        // Character set (utf8mb4)
        parts.push(Buffer.from([0x2d]));
        // Status flags
        parts.push(Buffer.from([0x02, 0x00]));
        // Capability flags (upper 2 bytes)
        parts.push(Buffer.from([0xff, 0x81]));
        // Auth data length
        parts.push(Buffer.from([0x15])); // 21 = 8 + 13
        // Reserved (10 bytes)
        parts.push(Buffer.alloc(10));
        // Auth-data-2 (remaining 12 bytes + null)
        parts.push(authChallenge.subarray(8, 20));
        parts.push(Buffer.from([0x00]));
        // Auth plugin name
        parts.push(authPluginName);

        const payload = Buffer.concat(parts);
        this.writePacket(socket, payload, 0);
    }

    private sendOK(socket: net.Socket, seqId: number, affectedRows: number = 0): void {
        const payload = Buffer.alloc(7);
        payload[0] = 0x00; // OK header
        payload[1] = affectedRows & 0xff; // Affected rows (lenenc)
        payload[2] = 0;    // Last insert ID
        payload.writeUInt16LE(0x0002, 3); // Status: SERVER_STATUS_AUTOCOMMIT
        payload.writeUInt16LE(0, 5); // Warnings
        this.writePacket(socket, payload, seqId);
    }

    private sendERR(socket: net.Socket, seqId: number, message: string): void {
        const msgBuf = Buffer.from(message, 'utf-8');
        const payload = Buffer.alloc(9 + msgBuf.length);
        payload[0] = 0xff; // ERR header
        payload.writeUInt16LE(1064, 1); // Error code (ER_PARSE_ERROR)
        payload[3] = 0x23; // '#' sql_state marker
        Buffer.from('42000').copy(payload, 4); // SQL state
        msgBuf.copy(payload, 9);
        this.writePacket(socket, payload, seqId);
    }

    private sendResultSet(socket: net.Socket, docs: DocumentWithId[], startSeqId: number): void {
        if (docs.length === 0) {
            this.sendOK(socket, startSeqId);
            return;
        }

        let seqId = startSeqId;

        // Determine columns
        const columns = Object.keys(docs[0]).filter(k => k !== '_id');
        if (columns.length === 0) columns.push('_id');

        // Column count packet
        const countPayload = Buffer.from([columns.length & 0xff]);
        this.writePacket(socket, countPayload, seqId++);

        // Column definition packets
        for (const col of columns) {
            const colDef = this.buildColumnDef(col);
            this.writePacket(socket, colDef, seqId++);
        }

        // EOF marker (deprecated in 4.1+ but still expected by some clients)
        this.sendEOF(socket, seqId++);

        // Row packets
        for (const doc of docs) {
            const row = this.buildTextRow(columns, doc);
            this.writePacket(socket, row, seqId++);
        }

        // Final EOF
        this.sendEOF(socket, seqId);
    }

    private buildColumnDef(name: string): Buffer {
        const parts: Buffer[] = [];

        // Catalog, schema, table, org_table — all "def" for compatibility
        const def = this.encodeLenencString('def');
        parts.push(def);
        parts.push(this.encodeLenencString('plugport')); // schema
        parts.push(this.encodeLenencString(''));          // virtual table
        parts.push(this.encodeLenencString(''));          // physical table
        parts.push(this.encodeLenencString(name));        // column name
        parts.push(this.encodeLenencString(name));        // original column name

        // Fixed-length fields
        const fixed = Buffer.alloc(13);
        fixed[0] = 0x0c; // Length of fixed-length fields
        fixed.writeUInt16LE(0x21, 1); // Character set (utf8_general_ci = 33)
        fixed.writeUInt32LE(255, 3);  // Column length
        fixed[7] = 0xfd; // Column type: VAR_STRING
        fixed.writeUInt16LE(0, 8);    // Flags
        fixed[10] = 0x00; // Decimals
        fixed.writeUInt16LE(0, 11);   // Filler

        parts.push(fixed);
        return Buffer.concat(parts);
    }

    private buildTextRow(columns: string[], doc: Record<string, unknown>): Buffer {
        const parts: Buffer[] = [];
        for (const col of columns) {
            const val = doc[col];
            if (val === null || val === undefined) {
                parts.push(Buffer.from([0xfb])); // NULL
            } else {
                const text = typeof val === 'object' ? JSON.stringify(val) : String(val);
                parts.push(this.encodeLenencString(text));
            }
        }
        return Buffer.concat(parts);
    }

    private sendEOF(socket: net.Socket, seqId: number): void {
        const payload = Buffer.alloc(5);
        payload[0] = 0xfe; // EOF header
        payload.writeUInt16LE(0, 1); // Warnings
        payload.writeUInt16LE(0x0002, 3); // Status: SERVER_STATUS_AUTOCOMMIT
        this.writePacket(socket, payload, seqId);
    }

    private encodeLenencString(str: string): Buffer {
        const strBuf = Buffer.from(str, 'utf-8');
        const len = strBuf.length;
        if (len < 251) {
            const buf = Buffer.alloc(1 + len);
            buf[0] = len;
            strBuf.copy(buf, 1);
            return buf;
        } else if (len < 0x10000) {
            const buf = Buffer.alloc(3 + len);
            buf[0] = 0xfc;
            buf.writeUInt16LE(len, 1);
            strBuf.copy(buf, 3);
            return buf;
        } else {
            const buf = Buffer.alloc(4 + len);
            buf[0] = 0xfd;
            buf[1] = len & 0xff;
            buf[2] = (len >> 8) & 0xff;
            buf[3] = (len >> 16) & 0xff;
            strBuf.copy(buf, 4);
            return buf;
        }
    }
}
