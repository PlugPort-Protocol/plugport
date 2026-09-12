// PlugPort SQL → Document Translator
// Parses SQL statements and translates them to DocumentStore operations.
// Used by both PostgreSQL and MySQL protocol frontends.
//
// Supports: SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, DROP TABLE,
//           CREATE INDEX, DROP INDEX, SHOW TABLES, DESCRIBE,
//           BEGIN/COMMIT/ROLLBACK (acknowledged no-ops).
//
// WHERE clause translation:  SQL operators → MongoDB-style filters
// JOIN support:               Delegated to JoinEngine (see join-engine.ts)

import { createRequire } from 'node:module';
import type { Filter, SortSpec, Projection, DocumentWithId } from '@plugport/shared';

// ---- Types ----

export interface TranslatedQuery {
    type: 'find' | 'insert' | 'update' | 'delete' | 'createCollection' | 'dropCollection'
        | 'createIndex' | 'dropIndex' | 'listCollections' | 'describe' | 'count'
        | 'aggregate' | 'join' | 'noop' | 'showDatabases' | 'use';
    collection?: string;
    filter?: Filter;
    projection?: Projection;
    sort?: SortSpec;
    limit?: number;
    skip?: number;
    documents?: Record<string, unknown>[];
    update?: { $set?: Record<string, unknown>; $unset?: Record<string, unknown>; $inc?: Record<string, number> };
    upsert?: boolean;
    multi?: boolean;
    indexField?: string;
    indexUnique?: boolean;
    indexName?: string;
    joinPlan?: JoinPlan;
    aggregation?: AggregationPlan;
    message?: string; // For noop messages like "BEGIN acknowledged"
}

export interface JoinPlan {
    type: 'INNER' | 'LEFT' | 'RIGHT' | 'CROSS';
    leftCollection: string;
    leftAlias: string;
    rightCollection: string;
    rightAlias: string;
    onCondition: { leftField: string; rightField: string };
    leftFilter?: Filter;
    rightFilter?: Filter;
    projection?: Projection;
    sort?: SortSpec;
    limit?: number;
    skip?: number;
    additionalJoins?: JoinPlan[]; // For multi-table JOINs
}

export interface AggregationPlan {
    groupBy: string[];
    aggregates: AggregateFunction[];
    having?: Filter;
}

export interface AggregateFunction {
    type: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
    field: string; // '*' for COUNT(*)
    alias: string;
}

// ---- SQL Parser ----

/**
 * SQL Translator: converts SQL strings into TranslatedQuery objects.
 *
 * Uses node-sql-parser for AST generation, then walks the AST to build
 * PlugPort-compatible DocumentStore operations.
 */
export class SQLTranslator {
    private parser: any;

    constructor() {
        // Lazy import — only loaded when SQL protocol is enabled
        try {
            const require = createRequire(import.meta.url);
            const { Parser } = require('node-sql-parser');
            this.parser = new Parser();
        } catch {
            throw new Error(
                'SQL protocol requires the "node-sql-parser" package. Install it with: pnpm add node-sql-parser'
            );
        }
    }

    /**
     * Translate a SQL statement into a TranslatedQuery.
     * @param sql The raw SQL string from the client
     * @returns TranslatedQuery ready for DocumentStore execution
     */
    translate(sql: string): TranslatedQuery {
        if (sql.length > 10000) {
            throw new Error('SQL parse error: Query exceeds maximum allowed length of 10000 characters');
        }

        const trimmed = sql.trim().replace(/;$/, '').trim();
        if (!trimmed) {
            return { type: 'noop', message: 'Empty query' };
        }

        // Handle transaction commands as acknowledged no-ops
        const upper = trimmed.toUpperCase();
        if (upper === 'BEGIN' || upper === 'START TRANSACTION') {
            return { type: 'noop', message: 'BEGIN acknowledged (PlugPort does not support transactions)' };
        }
        if (upper === 'COMMIT') {
            return { type: 'noop', message: 'COMMIT acknowledged' };
        }
        if (upper === 'ROLLBACK') {
            return { type: 'noop', message: 'ROLLBACK acknowledged' };
        }

        // Handle SHOW commands
        if (upper.startsWith('SHOW TABLES') || upper === '\\DT' || upper === 'SHOW COLLECTIONS') {
            return { type: 'listCollections' };
        }
        if (upper.startsWith('SHOW DATABASES') || upper === '\\L') {
            return { type: 'showDatabases' };
        }

        // Handle DESCRIBE / \d
        const describeMatch = upper.match(/^(?:DESCRIBE|DESC|\\D)\s+(\S+)/);
        if (describeMatch) {
            return { type: 'describe', collection: describeMatch[1].toLowerCase() };
        }

        // Handle USE database
        const useMatch = upper.match(/^USE\s+(\S+)/);
        if (useMatch) {
            return { type: 'use', message: `Using database: ${useMatch[1]}` };
        }

        // Handle PRAGMA (SQLite specific)
        if (upper.startsWith('PRAGMA')) {
            return { type: 'noop', message: 'PRAGMA ignored' };
        }

        // Parse with node-sql-parser
        let ast: any;
        try {
            ast = this.parser.astify(trimmed, { database: 'PostgreSQL' });
        } catch (err: any) {
            throw new Error(`SQL parse error: ${err.message}`);
        }

        // Depth/Complexity Check (Max depth 5 for nested queries / joins)
        const checkDepth = (node: any, currentDepth: number): number => {
            if (!node || typeof node !== 'object') return currentDepth;
            let maxDepth = currentDepth;
            if (node.type === 'select' || node.type === 'sub_expr' || node.type === 'dual' || node.join) {
                maxDepth++;
            }
            if (maxDepth > 5) throw new Error('SQL Complexity Limit Exceeded: Query is too deep or contains too many JOINs (Max 5)');
            
            for (const key in node) {
                if (node[key] && typeof node[key] === 'object') {
                    maxDepth = Math.max(maxDepth, checkDepth(node[key], currentDepth));
                }
            }
            return maxDepth;
        };
        checkDepth(ast, 0);

        // Handle multiple statements
        if (Array.isArray(ast)) {
            // For now, only process first statement
            ast = ast[0];
        }

        switch (ast.type) {
            case 'select': return this.translateSelect(ast);
            case 'insert': return this.translateInsert(ast);
            case 'update': return this.translateUpdate(ast);
            case 'delete': return this.translateDelete(ast);
            case 'create': return this.translateCreate(ast);
            case 'drop':   return this.translateDrop(ast);
            default:
                throw new Error(`Unsupported SQL statement type: ${ast.type}`);
        }
    }

    // ---- SELECT ----

    private translateSelect(ast: any): TranslatedQuery {
        // Check for JOINs
        if (ast.from && Array.isArray(ast.from) && ast.from.length > 1) {
            return this.translateJoin(ast);
        }

        const collection = this.extractTableName(ast.from);

        // Check for COUNT(*) or aggregate functions
        if (this.hasAggregates(ast.columns)) {
            return this.translateAggregate(ast, collection);
        }

        const result: TranslatedQuery = {
            type: 'find',
            collection,
        };

        // Projection
        if (!this.isWildcardSelect(ast.columns) && Array.isArray(ast.columns)) {
            result.projection = this.buildProjection(ast.columns);
        }

        // WHERE
        if (ast.where) {
            result.filter = this.translateWhere(ast.where);
        } else {
            result.filter = {};
        }

        // ORDER BY
        if (ast.orderby) {
            result.sort = this.buildSort(ast.orderby);
        }

        // LIMIT
        if (ast.limit) {
            if (ast.limit.value && ast.limit.value.length > 0) {
                // LIMIT with optional OFFSET
                if (ast.limit.value.length === 2) {
                    result.skip = ast.limit.value[0].value;
                    result.limit = ast.limit.value[1].value;
                } else {
                    result.limit = ast.limit.value[0].value;
                }
            }
        }

        // DISTINCT — fetch all, deduplicate in post-processing
        // (handled by the protocol server layer)

        return result;
    }

    // ---- INSERT ----

    private translateInsert(ast: any): TranslatedQuery {
        const collection = this.extractTableName(ast.table);
        const columns: string[] = ast.columns ? ast.columns.map((c: any) => c.value || c.column) : [];
        const documents: Record<string, unknown>[] = [];

        const valueRows = ast.values?.type === 'values' ? ast.values.values : ast.values;
        if (Array.isArray(valueRows)) {
            for (const row of valueRows) {
                const doc: Record<string, unknown> = {};
                const values = row.value;
                for (let i = 0; i < values.length; i++) {
                    const colName = columns[i] || `col${i}`;
                    doc[colName] = this.extractValue(values[i]);
                }
                documents.push(doc);
            }
        }

        return {
            type: 'insert',
            collection,
            documents,
        };
    }

    // ---- UPDATE ----

    private translateUpdate(ast: any): TranslatedQuery {
        const collection = this.extractTableName(ast.table);
        const $set: Record<string, unknown> = {};

        if (ast.set) {
            for (const item of ast.set) {
                const colName = this.extractColumnName(item);
                $set[colName] = this.extractValue(item.value);
            }
        }

        const result: TranslatedQuery = {
            type: 'update',
            collection,
            update: { $set },
            multi: true, // SQL UPDATE affects all matching rows by default
        };

        if (ast.where) {
            result.filter = this.translateWhere(ast.where);
        }

        return result;
    }

    // ---- DELETE ----

    private translateDelete(ast: any): TranslatedQuery {
        const collection = this.extractTableName(ast.from || ast.table);

        const result: TranslatedQuery = {
            type: 'delete',
            collection,
            multi: true,
            filter: {}
        };

        if (ast.where) {
            result.filter = this.translateWhere(ast.where);
        }

        return result;
    }

    // ---- CREATE TABLE / CREATE INDEX ----

    private translateCreate(ast: any): TranslatedQuery {
        if (ast.keyword === 'table' || ast.keyword === 'TABLE') {
            const collection = this.extractTableName(ast.table);
            return {
                type: 'createCollection',
                collection,
            };
        }

        if (ast.keyword === 'index' || ast.keyword === 'INDEX') {
            const indexName = ast.index || 'unnamed_index';
            const collection = this.extractTableName(ast.on || ast.table);
            const columns = ast.index_columns || [];
            let field = 'unknown';
            if (columns[0]) {
                const col = columns[0];
                field = typeof col === 'string' ? col : (col.column?.expr?.value || col.column?.expr?.column || col.column || col.expr?.column || 'unknown');
            }
            const unique = ast.index_type === 'unique' || ast.constraint_type === 'unique';

            return {
                type: 'createIndex',
                collection,
                indexField: field,
                indexUnique: unique,
                indexName: typeof indexName === 'string' ? indexName : indexName.index,
            };
        }

        throw new Error(`Unsupported CREATE type: ${ast.keyword}`);
    }

    // ---- DROP TABLE / DROP INDEX ----

    private translateDrop(ast: any): TranslatedQuery {
        if (ast.keyword === 'table' || ast.keyword === 'TABLE') {
            const collection = this.extractTableName(ast.name);
            return { type: 'dropCollection', collection };
        }

        if (ast.keyword === 'index' || ast.keyword === 'INDEX') {
            const indexName = ast.name?.index || ast.name || 'unnamed_index';
            const collection = this.extractTableName(ast.table);
            return {
                type: 'dropIndex',
                collection,
                indexName: typeof indexName === 'string' ? indexName : String(indexName),
            };
        }

        throw new Error(`Unsupported DROP type: ${ast.keyword}`);
    }

    // ---- JOIN ----

    private translateJoin(ast: any): TranslatedQuery {
        const from = ast.from;
        const leftTable = from[0];
        const rightTable = from[1];

        const joinPlan: JoinPlan = {
            type: this.mapJoinType(rightTable.join),
            leftCollection: this.extractTableRef(leftTable),
            leftAlias: leftTable.as || this.extractTableRef(leftTable),
            rightCollection: this.extractTableRef(rightTable),
            rightAlias: rightTable.as || this.extractTableRef(rightTable),
            onCondition: this.extractJoinCondition(rightTable.on),
        };

        // WHERE filter (applied to the combined result)
        if (ast.where) {
            // Try to push down filters to individual tables
            const whereFilter = this.translateWhere(ast.where);
            joinPlan.leftFilter = whereFilter; // For now, apply to left
        }

        // Projection
        let projection: Projection | undefined;
        if (!this.isWildcardSelect(ast.columns) && Array.isArray(ast.columns)) {
            projection = this.buildProjection(ast.columns);
        }
        joinPlan.projection = projection;

        // ORDER BY
        if (ast.orderby) {
            joinPlan.sort = this.buildSort(ast.orderby);
        }

        // LIMIT
        if (ast.limit?.value?.length) {
            joinPlan.limit = ast.limit.value[ast.limit.value.length - 1].value;
            if (ast.limit.value.length === 2) {
                joinPlan.skip = ast.limit.value[0].value;
            }
        }

        // Handle multi-table JOINs (A JOIN B JOIN C)
        if (from.length > 2) {
            joinPlan.additionalJoins = [];
            for (let i = 2; i < from.length; i++) {
                const extra = from[i];
                joinPlan.additionalJoins.push({
                    type: this.mapJoinType(extra.join),
                    leftCollection: '', // Resolved at execution time (result of previous join)
                    leftAlias: '',
                    rightCollection: this.extractTableRef(extra),
                    rightAlias: extra.as || this.extractTableRef(extra),
                    onCondition: this.extractJoinCondition(extra.on),
                });
            }
        }

        return {
            type: 'join',
            joinPlan,
            joinType: joinPlan.type, // add for test compat
        } as any;
    }

    // ---- Aggregation ----

    private translateAggregate(ast: any, collection: string): TranslatedQuery {
        const aggregates: AggregateFunction[] = [];
        const nonAggColumns: string[] = [];

        for (const col of ast.columns) {
            if (col.expr?.type === 'aggr_func') {
                const argField = col.expr.args?.expr ? this.extractColumnName(col.expr.args.expr) : '*';
                aggregates.push({
                    type: col.expr.name.toUpperCase() as AggregateFunction['type'],
                    field: argField,
                    alias: col.as || `${col.expr.name}(${argField})`,
                });
            } else if (col.expr?.type === 'column_ref') {
                nonAggColumns.push(this.extractColumnName(col.expr));
            }
        }

        // GROUP BY
        const groupBy: string[] = [];
        if (ast.groupby) {
            for (const g of ast.groupby) {
                if (g.column) groupBy.push(g.column);
                else if (g.expr?.column) groupBy.push(g.expr.column);
            }
        }

        const result: TranslatedQuery = {
            type: 'aggregate',
            collection,
            aggregation: { groupBy, aggregates, having: undefined },
        };

        // WHERE
        if (ast.where) {
            result.filter = this.translateWhere(ast.where);
        }

        // HAVING
        if (ast.having) {
            result.aggregation!.having = this.translateWhere(ast.having);
        }

        return result;
    }

    // ---- WHERE clause translation ----

    /**
     * Translates a SQL WHERE AST node into a MongoDB-style filter object.
     */
    translateWhere(node: any): Filter {
        if (!node) return {};

        // Binary expression: col op val
        if (node.type === 'binary_expr') {
            return this.translateBinaryExpr(node);
        }

        // Column reference (bare boolean check)
        if (node.type === 'column_ref') {
            return { [node.column]: { $ne: null } };
        }

        // Unary NOT
        if (node.type === 'unary_expr' && node.operator === 'NOT') {
            // Not supported natively, wrap in $not
            return {};
        }

        return {};
    }

    private translateBinaryExpr(node: any): Filter {
        const op = node.operator?.toUpperCase();

        // Logical operators
        if (op === 'AND') {
            const left = this.translateWhere(node.left);
            const right = this.translateWhere(node.right);
            return { $and: [left, right] };
        }
        if (op === 'OR') {
            const left = this.translateWhere(node.left);
            const right = this.translateWhere(node.right);
            return { $or: [left, right] } as any;
        }

        // Comparison operators
        const field = this.extractColumnName(node.left);
        const value = this.extractValue(node.right);

        switch (op) {
            case '=':   return { [field]: value };
            case '!=':
            case '<>':  return { [field]: { $ne: value } };
            case '>':   return { [field]: { $gt: value } };
            case '>=':  return { [field]: { $gte: value } };
            case '<':   return { [field]: { $lt: value } };
            case '<=':  return { [field]: { $lte: value } };

            case 'IN': {
                const vals = this.extractInValues(node.right);
                return { [field]: { $in: vals } };
            }

            case 'NOT IN': {
                const vals = this.extractInValues(node.right);
                return { [field]: { $nin: vals } } as any;
            }

            case 'LIKE': {
                const pattern = String(value)
                    .replace(/%/g, '.*')
                    .replace(/_/g, '.');
                return { [field]: { $regex: `^${pattern}$` } } as any;
            }

            case 'IS': {
                // IS NULL / IS NOT NULL
                if (node.right?.type === 'null' || value === null) {
                    return { [field]: { $exists: false } } as any;
                }
                return { [field]: value };
            }

            case 'IS NOT': {
                return { [field]: { $exists: true } } as any;
            }

            case 'BETWEEN': {
                const low = this.extractValue(node.right?.value?.[0]);
                const high = this.extractValue(node.right?.value?.[1]);
                return { $and: [{ [field]: { $gte: low } }, { [field]: { $lte: high } }] };
            }

            default:
                throw new Error(`Unsupported SQL operator: ${op}`);
        }
    }

    // ---- Helpers ----

    private extractTableName(node: any): string {
        if (!node) return 'unknown';
        if (typeof node === 'string') return node.toLowerCase();
        if (Array.isArray(node)) {
            const first = node[0];
            return (first?.table || first?.name || first?.value || 'unknown').toString().toLowerCase();
        }
        return (node.table || node.name || node.value || 'unknown').toString().toLowerCase();
    }

    private extractTableRef(node: any): string {
        if (typeof node === 'string') return node.toLowerCase();
        return (node.table || node.name || 'unknown').toString().toLowerCase();
    }

    private extractColumnName(node: any): string {
        if (!node) return 'unknown';
        if (typeof node === 'string') return node;
        if (node.type === 'column_ref' || node.column) {
            const col = node.column;
            if (typeof col === 'string') return col;
            if (col?.expr?.value) return col.expr.value;
            if (col?.expr?.column) return col.expr.column;
            return 'unknown';
        }
        if (node.expr?.value) return node.expr.value;
        if (node.expr?.column) return node.expr.column;
        return node.column || node.value || 'unknown';
    }

    private extractValue(node: any): unknown {
        if (!node) return null;
        if (typeof node !== 'object') return node;

        switch (node.type) {
            case 'number': return node.value;
            case 'string':
            case 'single_quote_string':
            case 'double_quote_string':
                return node.value;
            case 'bool': return node.value;
            case 'null': return null;
            case 'column_ref': return `$${this.extractColumnName(node)}`; // Field reference
            default:
                if (node.value !== undefined) return node.value;
                return null;
        }
    }

    private extractInValues(node: any): unknown[] {
        if (!node) return [];
        if (node.type === 'expr_list' && Array.isArray(node.value)) {
            return node.value.map((v: any) => this.extractValue(v));
        }
        if (Array.isArray(node)) {
            return node.map((v: any) => this.extractValue(v));
        }
        return [this.extractValue(node)];
    }

    private extractJoinCondition(on: any): { leftField: string; rightField: string } {
        if (!on) return { leftField: '_id', rightField: '_id' };

        // ON a.field = b.field
        if (on.type === 'binary_expr' && on.operator === '=') {
            return {
                leftField: on.left?.column || '_id',
                rightField: on.right?.column || '_id',
            };
        }

        return { leftField: '_id', rightField: '_id' };
    }

    private mapJoinType(joinKeyword: string | undefined): JoinPlan['type'] {
        if (!joinKeyword) return 'INNER';
        const upper = joinKeyword.toUpperCase();
        if (upper.includes('LEFT')) return 'LEFT';
        if (upper.includes('RIGHT')) return 'RIGHT';
        if (upper.includes('CROSS')) return 'CROSS';
        return 'INNER';
    }

    /**
     * node-sql-parser never represents `SELECT *` as the literal string '*' — it always
     * returns an array, even for a bare wildcard: `[{ expr: { type: 'column_ref', column: '*' }, as: null }]`.
     * A naive `columns !== '*'` check therefore never catches the wildcard case, causing
     * buildProjection() to build a bogus inclusion projection for a field literally named "*",
     * which matches no real document field and silently strips every field but _id.
     */
    private isWildcardSelect(columns: unknown): boolean {
        if (columns === '*') return true;
        if (!Array.isArray(columns) || columns.length !== 1) return false;
        const col = columns[0];
        return col?.expr?.type === 'column_ref' && col.expr.column === '*' && !col.expr.table;
    }

    private buildProjection(columns: any[]): Projection {
        const proj: Projection = {};
        for (const col of columns) {
            if (col.expr?.type === 'column_ref') {
                // node-sql-parser (PostgreSQL dialect) wraps `column` in a nested
                // { expr: { type, value } } object rather than a plain string — extractColumnName
                // already knows how to unwrap that; a raw `col.expr.column` access does not, and
                // silently keys the projection on the stringified object instead of the real name.
                const name = col.as || this.extractColumnName(col.expr);
                proj[name] = 1;
            }
        }
        return proj;
    }

    private buildSort(orderby: any[]): SortSpec {
        const sort: SortSpec = {};
        for (const item of orderby) {
            const col = this.extractColumnName(item.expr || item);
            if (col && col !== 'unknown') {
                sort[col] = item.type === 'DESC' ? -1 : 1;
            }
        }
        return sort;
    }

    private hasAggregates(columns: any): boolean {
        if (columns === '*' || !Array.isArray(columns)) return false;
        return columns.some((col: any) => col.expr?.type === 'aggr_func');
    }
}
