/**
 * @plugport/sqlite-compat
 *
 * Drop-in replacement for better-sqlite3 that uses PlugPort HTTP API as backend.
 * All data is stored on Monad blockchain via PlugPort server.
 *
 * Usage:
 *   // Before (better-sqlite3):
 *   import Database from 'better-sqlite3';
 *   const db = new Database(':memory:');
 *
 *   // After (PlugPort):
 *   import Database from '@plugport/sqlite-compat';
 *   const db = new Database('http://localhost:8080');
 *
 *   // Same API from here:
 *   db.exec('CREATE TABLE users (id INTEGER, name TEXT)');
 *   const insert = db.prepare('INSERT INTO users VALUES (?, ?)');
 *   insert.run(1, 'Alice');
 *   const rows = db.prepare('SELECT * FROM users').all();
 *
 * Limitations:
 *   - All operations are synchronous-looking but internally use HTTP fetch
 *   - Transactions are acknowledged but not atomic (Monad is eventual)
 *   - WAL mode and pragmas are no-ops
 *   - Virtual tables are not supported
 */

import { Parser } from 'node-sql-parser';

// ---- Types ----

export interface DatabaseOptions {
    /** API key for authentication */
    apiKey?: string;
    /** Request timeout in milliseconds */
    timeout?: number;
    /** Whether to log SQL statements */
    verbose?: boolean;
}

export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
}

export interface Statement {
    /** Run a statement that modifies data (INSERT, UPDATE, DELETE) */
    run(...params: unknown[]): RunResult;
    /** Get a single row */
    get(...params: unknown[]): Record<string, unknown> | undefined;
    /** Get all rows */
    all(...params: unknown[]): Record<string, unknown>[];
    /** Iterate rows */
    iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
    /** Bind parameters and return a new Statement */
    bind(...params: unknown[]): Statement;
    /** The original SQL */
    source: string;
    /** Number of columns in the result set */
    columns(): ColumnDefinition[];
    /** Whether the statement is read-only */
    reader: boolean;
}

export interface ColumnDefinition {
    name: string;
    column: string | null;
    table: string | null;
    database: string | null;
    type: string | null;
}

export interface Transaction<F extends (...args: unknown[]) => unknown> {
    (...args: Parameters<F>): ReturnType<F>;
    deferred: (...args: Parameters<F>) => ReturnType<F>;
    immediate: (...args: Parameters<F>) => ReturnType<F>;
    exclusive: (...args: Parameters<F>) => ReturnType<F>;
}

// ---- SQLite Compat Database ----

/**
 * Drop-in replacement for better-sqlite3's Database class.
 * Routes all SQL operations to PlugPort HTTP API → Monad blockchain.
 */
export class Database {
    readonly name: string;
    readonly open: boolean = true;
    readonly inTransaction: boolean = false;
    readonly readonly: boolean = false;
    readonly memory: boolean = false;

    private baseUrl: string;
    private headers: Record<string, string>;
    private timeout: number;
    private verbose: boolean;
    private parser: Parser;
    private lastInsertRowid: number = 0;

    /**
     * @param urlOrFilename PlugPort server URL (e.g., 'http://localhost:8080')
     *                      or ':memory:' for in-memory (connects to localhost:8080)
     * @param options Configuration options
     */
    constructor(urlOrFilename: string, options: DatabaseOptions = {}) {
        if (urlOrFilename === ':memory:' || urlOrFilename === '') {
            this.baseUrl = 'http://localhost:8080';
            this.memory = true;
        } else {
            this.baseUrl = urlOrFilename.startsWith('http') ? urlOrFilename : 'http://localhost:8080';
        }

        this.name = urlOrFilename;
        this.headers = { 'Content-Type': 'application/json' };
        if (options.apiKey) {
            this.headers['x-api-key'] = options.apiKey;
        }
        this.timeout = options.timeout || 30000;
        this.verbose = options.verbose || false;
        this.parser = new Parser();
    }

    /**
     * Execute one or more SQL statements (no return value).
     * Used for CREATE TABLE, DROP TABLE, etc.
     */
    exec(sql: string): this {
        const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
        for (const stmt of statements) {
            this.executeStatement(stmt, []);
        }
        return this;
    }

    /**
     * Prepare a SQL statement for repeated execution.
     */
    prepare(sql: string): Statement {
        const self = this;
        const normalizedSql = sql.trim();
        const isReader = /^\s*(SELECT|PRAGMA|EXPLAIN)/i.test(normalizedSql);

        let boundParams: unknown[] = [];

        const statement: Statement = {
            source: normalizedSql,
            reader: isReader,

            run(...params: unknown[]): RunResult {
                const allParams = params.length > 0 ? params : boundParams;
                const result = self.executeStatement(normalizedSql, allParams);
                return {
                    changes: result.changes || 0,
                    lastInsertRowid: result.lastInsertRowid || 0,
                };
            },

            get(...params: unknown[]): Record<string, unknown> | undefined {
                const allParams = params.length > 0 ? params : boundParams;
                const result = self.executeStatement(normalizedSql, allParams);
                return result.rows?.[0];
            },

            all(...params: unknown[]): Record<string, unknown>[] {
                const allParams = params.length > 0 ? params : boundParams;
                const result = self.executeStatement(normalizedSql, allParams);
                return result.rows || [];
            },

            *iterate(...params: unknown[]): IterableIterator<Record<string, unknown>> {
                const rows = statement.all(...params);
                for (const row of rows) {
                    yield row;
                }
            },

            bind(...params: unknown[]): Statement {
                boundParams = params;
                return statement;
            },

            columns(): ColumnDefinition[] {
                // Try to extract column names from SELECT statement
                try {
                    const ast = self.parser.astify(normalizedSql) as any;
                    if (ast?.columns && Array.isArray(ast.columns)) {
                        return ast.columns.map((col: any) => ({
                            name: col.as || col.column || '*',
                            column: col.column || null,
                            table: col.table || null,
                            database: null,
                            type: null,
                        }));
                    }
                } catch { /* ignore parse errors */ }
                return [];
            },
        };

        return statement;
    }

    /**
     * Create a transaction function.
     * Note: Transactions on Monad are not truly atomic. Each statement
     * is executed individually. The transaction wrapper provides API
     * compatibility with better-sqlite3.
     */
    transaction<F extends (...args: any[]) => any>(fn: F): Transaction<F> {
        const wrapper = ((...args: any[]) => {
            return fn(...args);
        }) as Transaction<F>;

        wrapper.deferred = wrapper;
        wrapper.immediate = wrapper;
        wrapper.exclusive = wrapper;

        return wrapper;
    }

    /**
     * Set a PRAGMA value. Most are no-ops for compatibility.
     */
    pragma(sql: string, options?: { simple?: boolean }): unknown {
        const match = sql.match(/^(\w+)\s*(?:=\s*(.+))?$/);
        if (!match) return options?.simple ? undefined : [];

        const [, name, value] = match;

        // Return compatibility values
        const pragmaDefaults: Record<string, unknown> = {
            journal_mode: 'wal',
            wal_checkpoint: 'ok',
            foreign_keys: 1,
            cache_size: -2000,
            busy_timeout: 5000,
            synchronous: 1,
            temp_store: 2,
            mmap_size: 0,
            page_size: 4096,
            user_version: 0,
        };

        if (value !== undefined) {
            // SET pragma — acknowledge but no-op
            return options?.simple ? value : { [name]: value };
        }

        const result = pragmaDefaults[name.toLowerCase()] ?? null;
        return options?.simple ? result : (result !== null ? [{ [name]: result }] : []);
    }

    /** Close the database connection (no-op for HTTP). */
    close(): void {
        (this as any).open = false;
    }

    /** Create a user-defined function (no-op for compatibility). */
    function(name: string, fn: (...args: unknown[]) => unknown): this;
    function(name: string, options: { deterministic?: boolean }, fn: (...args: unknown[]) => unknown): this;
    function(name: string, optionsOrFn: any, maybeFn?: any): this {
        // User-defined functions can't be forwarded to the server
        // Acknowledge for API compatibility
        return this;
    }

    /** Create a user-defined aggregate (no-op for compatibility). */
    aggregate(name: string, options: any): this {
        return this;
    }

    /** Create a backup (not supported). */
    backup(destination: string): Promise<void> {
        return Promise.resolve();
    }

    /** Load an extension (not supported). */
    loadExtension(path: string): this {
        return this;
    }

    // ---- Internal ----

    private executeStatement(sql: string, params: unknown[]): {
        rows?: Record<string, unknown>[];
        changes?: number;
        lastInsertRowid?: number;
    } {
        if (this.verbose) {
            console.log('[PlugPort SQLite]', sql, params.length > 0 ? params : '');
        }

        const resolvedSql = this.resolveParams(sql, params);
        const upperSql = resolvedSql.trim().toUpperCase();

        // Handle PRAGMA
        if (upperSql.startsWith('PRAGMA')) {
            return { rows: [] };
        }

        // Handle BEGIN/COMMIT/ROLLBACK (no-ops)
        if (upperSql === 'BEGIN' || upperSql === 'BEGIN TRANSACTION' ||
            upperSql === 'COMMIT' || upperSql === 'ROLLBACK' ||
            upperSql === 'END' || upperSql === 'END TRANSACTION') {
            return { changes: 0 };
        }

        // Detect statement type
        if (upperSql.startsWith('CREATE TABLE') || upperSql.startsWith('CREATE INDEX') ||
            upperSql.startsWith('DROP TABLE') || upperSql.startsWith('DROP INDEX') ||
            upperSql.startsWith('ALTER TABLE')) {
            return this.executeDDL(resolvedSql);
        }

        if (upperSql.startsWith('INSERT')) {
            return this.executeInsert(resolvedSql);
        }

        if (upperSql.startsWith('SELECT') || upperSql.startsWith('WITH')) {
            return this.executeSelect(resolvedSql);
        }

        if (upperSql.startsWith('UPDATE')) {
            return this.executeUpdate(resolvedSql);
        }

        if (upperSql.startsWith('DELETE')) {
            return this.executeDelete(resolvedSql);
        }

        // Default: try as exec
        return { changes: 0 };
    }

    private executeDDL(sql: string): { changes: number } {
        // Parse to extract table name
        const createMatch = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/i);
        if (createMatch) {
            // Create collection via HTTP (auto-created on first insert)
            // Just acknowledge
            return { changes: 0 };
        }

        const dropMatch = sql.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"]?(\w+)[`"]?/i);
        if (dropMatch) {
            const collection = dropMatch[1];
            this.httpRequest('POST', `/api/v1/collections/${collection}/drop`, {});
            return { changes: 0 };
        }

        const indexMatch = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?\s+ON\s+[`"]?(\w+)[`"]?\s*\(([^)]+)\)/i);
        if (indexMatch) {
            const [, indexName, table, fields] = indexMatch;
            const field = fields.split(',')[0].trim().replace(/[`"]/g, '');
            const unique = /UNIQUE/i.test(sql);
            this.httpRequest('POST', `/api/v1/collections/${table}/createIndex`, {
                field,
                unique,
                name: indexName,
            });
            return { changes: 0 };
        }

        return { changes: 0 };
    }

    private executeInsert(sql: string): { changes: number; lastInsertRowid: number } {
        try {
            const ast = this.parser.astify(sql) as any;
            const table = ast?.table?.[0]?.table || this.extractTableName(sql, 'INSERT');
            if (!table) return { changes: 0, lastInsertRowid: 0 };

            const columns = ast?.columns || [];
            const valuesList = ast?.values || [];

            let inserted = 0;
            for (const valueSet of valuesList) {
                const doc: Record<string, unknown> = {};
                const values = valueSet?.value || [];
                for (let i = 0; i < columns.length && i < values.length; i++) {
                    doc[columns[i]] = values[i]?.value ?? values[i];
                }
                this.httpRequest('POST', `/api/v1/collections/${table}/insertOne`, {
                    document: doc,
                });
                inserted++;
            }

            this.lastInsertRowid++;
            return { changes: inserted, lastInsertRowid: this.lastInsertRowid };
        } catch {
            // Fallback: regex-based parse
            return this.executeInsertFallback(sql);
        }
    }

    private executeInsertFallback(sql: string): { changes: number; lastInsertRowid: number } {
        const match = sql.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+[`"]?(\w+)[`"]?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
        if (!match) return { changes: 0, lastInsertRowid: 0 };

        const [, table, colStr, valStr] = match;
        const columns = colStr.split(',').map(c => c.trim().replace(/[`"]/g, ''));
        const values = valStr.split(',').map(v => {
            const trimmed = v.trim();
            if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
            if (trimmed === 'NULL' || trimmed === 'null') return null;
            const num = Number(trimmed);
            return isNaN(num) ? trimmed : num;
        });

        const doc: Record<string, unknown> = {};
        columns.forEach((col, i) => { doc[col] = values[i] ?? null; });

        this.httpRequest('POST', `/api/v1/collections/${table}/insertOne`, { document: doc });
        this.lastInsertRowid++;
        return { changes: 1, lastInsertRowid: this.lastInsertRowid };
    }

    private executeSelect(sql: string): { rows: Record<string, unknown>[] } {
        try {
            const ast = this.parser.astify(sql) as any;
            const table = ast?.from?.[0]?.table || this.extractTableName(sql, 'SELECT');
            if (!table) return { rows: [] };

            const filter = this.whereToFilter(ast?.where);
            const sort = this.orderByToSort(ast?.orderby);
            const limit = ast?.limit?.value?.[0]?.value;

            const result = this.httpRequest('POST', `/api/v1/collections/${table}/find`, {
                filter,
                sort: Object.keys(sort).length > 0 ? sort : undefined,
                limit: limit || 1000,
            }) as { cursor?: { firstBatch?: Record<string, unknown>[] } };

            const rows = result?.cursor?.firstBatch || [];

            // Apply projection
            if (ast?.columns && ast.columns !== '*' && Array.isArray(ast.columns)) {
                const selectedCols = ast.columns.map((c: any) => c.as || c.expr?.column || c.column).filter(Boolean);
                if (selectedCols.length > 0 && selectedCols[0] !== '*') {
                    return {
                        rows: rows.map(row => {
                            const projected: Record<string, unknown> = {};
                            for (const col of selectedCols) {
                                if (col in row) projected[col] = row[col];
                            }
                            return projected;
                        }),
                    };
                }
            }

            return { rows };
        } catch {
            // Fallback
            const table = this.extractTableName(sql, 'SELECT');
            if (!table) return { rows: [] };
            const result = this.httpRequest('POST', `/api/v1/collections/${table}/find`, {
                filter: {},
                limit: 1000,
            }) as { cursor?: { firstBatch?: Record<string, unknown>[] } };
            return { rows: result?.cursor?.firstBatch || [] };
        }
    }

    private executeUpdate(sql: string): { changes: number } {
        try {
            const ast = this.parser.astify(sql) as any;
            const table = ast?.table?.[0]?.table || this.extractTableName(sql, 'UPDATE');
            if (!table) return { changes: 0 };

            const filter = this.whereToFilter(ast?.where);
            const updates: Record<string, unknown> = {};
            for (const setItem of ast?.set || []) {
                if (setItem.column && setItem.value !== undefined) {
                    updates[setItem.column] = setItem.value?.value ?? setItem.value;
                }
            }

            const result = this.httpRequest('POST', `/api/v1/collections/${table}/updateMany`, {
                filter,
                update: { $set: updates },
            }) as { modifiedCount?: number };

            return { changes: result?.modifiedCount || 0 };
        } catch {
            return { changes: 0 };
        }
    }

    private executeDelete(sql: string): { changes: number } {
        try {
            const ast = this.parser.astify(sql) as any;
            const table = ast?.from?.[0]?.table || this.extractTableName(sql, 'DELETE');
            if (!table) return { changes: 0 };

            const filter = this.whereToFilter(ast?.where);

            const result = this.httpRequest('POST', `/api/v1/collections/${table}/deleteMany`, {
                filter,
            }) as { deletedCount?: number };

            return { changes: result?.deletedCount || 0 };
        } catch {
            return { changes: 0 };
        }
    }

    // ---- SQL Helpers ----

    private resolveParams(sql: string, params: unknown[]): string {
        if (params.length === 0) return sql;

        let idx = 0;
        // Handle named parameters (:name, $name, @name)
        if (params.length === 1 && typeof params[0] === 'object' && params[0] !== null && !Array.isArray(params[0])) {
            const named = params[0] as Record<string, unknown>;
            return sql.replace(/[:$@](\w+)/g, (_, name) => {
                return this.sqlValue(named[name]);
            });
        }

        // Handle positional parameters (?)
        return sql.replace(/\?/g, () => {
            return this.sqlValue(params[idx++]);
        });
    }

    private sqlValue(val: unknown): string {
        if (val === null || val === undefined) return 'NULL';
        if (typeof val === 'number') return String(val);
        if (typeof val === 'boolean') return val ? '1' : '0';
        if (typeof val === 'bigint') return String(val);
        if (val instanceof Uint8Array || val instanceof ArrayBuffer) return `X'${Buffer.from(val as any).toString('hex')}'`;
        return `'${String(val).replace(/'/g, "''")}'`;
    }

    private whereToFilter(where: any): Record<string, unknown> {
        if (!where) return {};
        return this.astNodeToFilter(where);
    }

    private astNodeToFilter(node: any): Record<string, unknown> {
        if (!node) return {};

        if (node.type === 'binary_expr') {
            const left = node.left?.column || node.left?.value;
            const right = node.right?.value ?? node.right?.column;

            switch (node.operator) {
                case '=': return { [left]: right };
                case '!=': case '<>': return { [left]: { $ne: right } };
                case '>': return { [left]: { $gt: right } };
                case '>=': return { [left]: { $gte: right } };
                case '<': return { [left]: { $lt: right } };
                case '<=': return { [left]: { $lte: right } };
                case 'AND': return { ...this.astNodeToFilter(node.left), ...this.astNodeToFilter(node.right) };
                case 'OR': return { $or: [this.astNodeToFilter(node.left), this.astNodeToFilter(node.right)] } as any;
                case 'LIKE': return { [left]: { $regex: String(right).replace(/%/g, '.*').replace(/_/g, '.') } };
                case 'IN': {
                    const vals = (node.right?.value || []).map((v: any) => v?.value ?? v);
                    return { [left]: { $in: vals } };
                }
                case 'IS': {
                    if (right === null || node.right?.type === 'null') return { [left]: null };
                    return { [left]: right };
                }
            }
        }

        return {};
    }

    private orderByToSort(orderby: any[]): Record<string, 1 | -1> {
        if (!orderby || !Array.isArray(orderby)) return {};
        const sort: Record<string, 1 | -1> = {};
        for (const item of orderby) {
            const col = item.expr?.column || item.column;
            if (col) sort[col] = item.type === 'DESC' ? -1 : 1;
        }
        return sort;
    }

    private extractTableName(sql: string, type: string): string | null {
        const patterns: Record<string, RegExp> = {
            SELECT: /FROM\s+[`"]?(\w+)[`"]?/i,
            INSERT: /INTO\s+[`"]?(\w+)[`"]?/i,
            UPDATE: /UPDATE\s+[`"]?(\w+)[`"]?/i,
            DELETE: /FROM\s+[`"]?(\w+)[`"]?/i,
        };
        const match = sql.match(patterns[type] || patterns.SELECT);
        return match?.[1] || null;
    }

    private httpRequest(method: string, path: string, body: unknown): unknown {
        // Synchronous HTTP request using XMLHttpRequest (Node.js compatibility)
        // This enables the synchronous API that better-sqlite3 users expect
        try {
            const url = `${this.baseUrl}${path}`;

            // Use synchronous fetch via execSync workaround for Node.js
            const { execSync } = require('child_process');
            const curlCmd = method === 'POST'
                ? `curl -s -X POST "${url}" -H "Content-Type: application/json" ${this.headers['x-api-key'] ? `-H "x-api-key: ${this.headers['x-api-key']}"` : ''} -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`
                : `curl -s "${url}" ${this.headers['x-api-key'] ? `-H "x-api-key: ${this.headers['x-api-key']}"` : ''}`;

            const result = execSync(curlCmd, {
                timeout: this.timeout,
                encoding: 'utf-8',
            });

            return JSON.parse(result);
        } catch (err: any) {
            if (this.verbose) {
                console.error('[PlugPort SQLite] HTTP request failed:', err.message);
            }
            return {};
        }
    }
}

// Default export for better-sqlite3 API compatibility
export default Database;
