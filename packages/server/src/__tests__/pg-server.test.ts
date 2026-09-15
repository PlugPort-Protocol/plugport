// PostgreSQL Wire Protocol Server Tests
// Covers the Extended Query Protocol (Parse/Bind/Execute/Close) — previously
// Execute always returned a fake "0 rows" response without running
// anything. Tests both the message-parsing helpers directly and a full
// wire-byte-level Parse→Bind→Execute flow against a real DocumentStore.

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PGServer } from '../protocols/pg-server.js';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';

// ---- Wire message builders (mirror what a real libpq-based client sends) ----

function cstr(s: string): Buffer {
    return Buffer.from(s + '\0', 'utf-8');
}

function frontendMessage(type: string, body: Buffer): Buffer {
    const msg = Buffer.alloc(1 + 4 + body.length);
    msg[0] = type.charCodeAt(0);
    msg.writeInt32BE(4 + body.length, 1);
    body.copy(msg, 5);
    return msg;
}

function parseMessage(statementName: string, query: string, paramOids: number[] = []): Buffer {
    const body = Buffer.concat([
        cstr(statementName),
        cstr(query),
        (() => { const b = Buffer.alloc(2); b.writeInt16BE(paramOids.length, 0); return b; })(),
        ...paramOids.map((oid) => { const b = Buffer.alloc(4); b.writeInt32BE(oid, 0); return b; }),
    ]);
    return frontendMessage('P', body);
}

function bindMessage(portalName: string, statementName: string, params: (string | null)[]): Buffer {
    const parts: Buffer[] = [
        cstr(portalName),
        cstr(statementName),
        int16(0), // no param format codes -> all text
        int16(params.length),
    ];
    for (const p of params) {
        if (p === null) {
            parts.push(int32(-1));
        } else {
            const valBuf = Buffer.from(p, 'utf-8');
            parts.push(int32(valBuf.length), valBuf);
        }
    }
    parts.push(int16(0)); // no result format codes -> all text
    return frontendMessage('B', Buffer.concat(parts));
}

function executeMessage(portalName: string, maxRows = 0): Buffer {
    return frontendMessage('E', Buffer.concat([cstr(portalName), int32(maxRows)]));
}

function closeMessage(kind: 'S' | 'P', name: string): Buffer {
    return frontendMessage('C', Buffer.concat([Buffer.from(kind), cstr(name)]));
}

function int16(n: number): Buffer { const b = Buffer.alloc(2); b.writeInt16BE(n, 0); return b; }
function int32(n: number): Buffer { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; }

// ---- Fake socket: captures writes, lets us feed raw bytes as "data" events ----

class FakeSocket extends EventEmitter {
    written: Buffer[] = [];
    write(data: Buffer): boolean {
        this.written.push(Buffer.from(data));
        return true;
    }
    end(): void {}
    destroy(): void {}

    /** Decode all captured writes into a flat list of {type, body} backend messages. */
    decodeMessages(): { type: string; body: Buffer }[] {
        const all = Buffer.concat(this.written);
        const messages: { type: string; body: Buffer }[] = [];
        let offset = 0;
        while (offset < all.length) {
            const type = String.fromCharCode(all[offset]);
            const length = all.readInt32BE(offset + 1);
            const body = all.subarray(offset + 5, offset + 1 + length);
            messages.push({ type, body });
            offset += 1 + length;
        }
        return messages;
    }
}

describe('PGServer', () => {
    let store: DocumentStore;
    let server: PGServer;

    beforeEach(() => {
        store = new DocumentStore(new InMemoryKVStore());
        server = new PGServer({ store });
    });

    describe('message parsing helpers', () => {
        it('parseParseMessage extracts statement name and query', () => {
            const body = parseMessage('stmt1', 'SELECT * FROM users WHERE id = $1').subarray(5);
            const result = (server as any).parseParseMessage(body);
            expect(result.statementName).toBe('stmt1');
            expect(result.query).toBe('SELECT * FROM users WHERE id = $1');
        });

        it('parseParseMessage handles the unnamed statement ("")', () => {
            const body = parseMessage('', 'SELECT 1').subarray(5);
            const result = (server as any).parseParseMessage(body);
            expect(result.statementName).toBe('');
        });

        it('parseBindMessage extracts portal, statement, and param values', () => {
            const body = bindMessage('portal1', 'stmt1', ['alice', '42', null]).subarray(5);
            const result = (server as any).parseBindMessage(body);
            expect(result.portalName).toBe('portal1');
            expect(result.statementName).toBe('stmt1');
            expect(result.paramValues.map((v: Buffer | null) => v?.toString('utf-8') ?? null)).toEqual(['alice', '42', null]);
        });

        it('parseExecuteMessage extracts the portal name', () => {
            const body = executeMessage('portal1').subarray(5);
            const result = (server as any).parseExecuteMessage(body);
            expect(result.portalName).toBe('portal1');
        });

        it('parseCloseMessage distinguishes statement vs portal', () => {
            const stmtBody = closeMessage('S', 'stmt1').subarray(5);
            expect((server as any).parseCloseMessage(stmtBody)).toEqual({ kind: 'S', name: 'stmt1' });

            const portalBody = closeMessage('P', 'portal1').subarray(5);
            expect((server as any).parseCloseMessage(portalBody)).toEqual({ kind: 'P', name: 'portal1' });
        });
    });

    describe('substituteParams', () => {
        it('substitutes a string parameter as a quoted literal', () => {
            const sql = (server as any).substituteParams(
                "INSERT INTO users (name) VALUES ($1)",
                [Buffer.from('alice', 'utf-8')],
            );
            expect(sql).toBe("INSERT INTO users (name) VALUES ('alice')");
        });

        it('substitutes a numeric parameter unquoted', () => {
            const sql = (server as any).substituteParams(
                'SELECT * FROM users WHERE age = $1',
                [Buffer.from('42', 'utf-8')],
            );
            expect(sql).toBe('SELECT * FROM users WHERE age = 42');
        });

        it('substitutes NULL for a null-bound parameter', () => {
            const sql = (server as any).substituteParams(
                'UPDATE users SET name = $1 WHERE id = $2',
                [null, Buffer.from('1', 'utf-8')],
            );
            expect(sql).toBe('UPDATE users SET name = NULL WHERE id = 1');
        });

        it('escapes embedded single quotes', () => {
            const sql = (server as any).substituteParams(
                'INSERT INTO users (name) VALUES ($1)',
                [Buffer.from("O'Brien", 'utf-8')],
            );
            expect(sql).toBe("INSERT INTO users (name) VALUES ('O''Brien')");
        });

        it('substitutes multiple parameters by position', () => {
            const sql = (server as any).substituteParams(
                'INSERT INTO users (name, age) VALUES ($1, $2)',
                [Buffer.from('bob', 'utf-8'), Buffer.from('30', 'utf-8')],
            );
            expect(sql).toBe("INSERT INTO users (name, age) VALUES ('bob', 30)");
        });
    });

    describe('Extended Query Protocol end-to-end (real wire bytes)', () => {
        it('actually inserts a document via Parse -> Bind -> Execute -> Sync (was previously a fake no-op)', async () => {
            const socket = new FakeSocket();
            (server as any).authenticatedSockets.add(socket); // no apiKey configured -> irrelevant, but explicit

            await (server as any).handleMessage(
                socket,
                'P'.charCodeAt(0),
                parseMessage('', 'INSERT INTO users (name, age) VALUES ($1, $2)').subarray(5),
            );
            await (server as any).handleMessage(
                socket,
                'B'.charCodeAt(0),
                bindMessage('', '', ['alice', '30']).subarray(5),
            );
            await (server as any).handleMessage(
                socket,
                'E'.charCodeAt(0),
                executeMessage('').subarray(5),
            );

            const messages = socket.decodeMessages();
            expect(messages.some(m => m.type === '1')).toBe(true); // ParseComplete
            expect(messages.some(m => m.type === '2')).toBe(true); // BindComplete
            expect(messages.some(m => m.type === 'C')).toBe(true); // CommandComplete
            expect(messages.some(m => m.type === 'E')).toBe(false); // no ErrorResponse

            const cmdComplete = messages.find(m => m.type === 'C')!;
            const tag = cmdComplete.body.toString('utf-8').replace(/\0$/, '');
            expect(tag).toBe('INSERT 0 1');

            // The real proof: the document actually landed in the store.
            const found = await store.find('users', {});
            expect(found.cursor.firstBatch).toHaveLength(1);
            expect(found.cursor.firstBatch[0].name).toBe('alice');
            expect(found.cursor.firstBatch[0].age).toBe(30);
        });

        it('actually runs a parameterized SELECT and returns real rows', async () => {
            await store.insert('users', [{ name: 'alice', age: 30 }, { name: 'bob', age: 25 }] as any);

            const socket = new FakeSocket();
            await (server as any).handleMessage(
                socket, 'P'.charCodeAt(0),
                parseMessage('', 'SELECT * FROM users WHERE name = $1').subarray(5),
            );
            await (server as any).handleMessage(
                socket, 'B'.charCodeAt(0),
                bindMessage('', '', ['alice']).subarray(5),
            );
            await (server as any).handleMessage(
                socket, 'E'.charCodeAt(0),
                executeMessage('').subarray(5),
            );

            const messages = socket.decodeMessages();
            const dataRows = messages.filter(m => m.type === 'D');
            expect(dataRows).toHaveLength(1); // only alice, not bob

            const cmdComplete = messages.find(m => m.type === 'C')!;
            expect(cmdComplete.body.toString('utf-8').replace(/\0$/, '')).toBe('SELECT 1');
        });

        it('errors cleanly when Execute references an unknown portal', async () => {
            const socket = new FakeSocket();
            await (server as any).handleMessage(
                socket, 'E'.charCodeAt(0),
                executeMessage('nonexistent-portal').subarray(5),
            );
            const messages = socket.decodeMessages();
            expect(messages.some(m => m.type === 'E')).toBe(true); // ErrorResponse
        });

        it('Close removes a statement so a later Bind referencing it fails', async () => {
            const socket = new FakeSocket();
            await (server as any).handleMessage(socket, 'P'.charCodeAt(0), parseMessage('s1', 'SELECT 1').subarray(5));
            await (server as any).handleMessage(socket, 'C'.charCodeAt(0), closeMessage('S', 's1').subarray(5));

            const messages = socket.decodeMessages();
            expect(messages.some(m => m.type === '3')).toBe(true); // CloseComplete
            expect((server as any).getStatements(socket).has('s1')).toBe(false);
        });
    });
});
