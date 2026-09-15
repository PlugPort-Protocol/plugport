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
import { ErrorCodes } from '@plugport/shared';
import { DocumentStoreError } from '../storage/document-store.js';
import { matchesFilter } from '../storage/query-planner.js';

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
    /**
     * Aliases in `aggregates` that were added solely to evaluate a HAVING
     * clause referencing an aggregate not present in the SELECT list —
     * computed for filtering, then stripped from the final result rows.
     */
    havingOnlyAliases?: string[];
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
export type SQLDialect = 'PostgreSQL' | 'MySQL';

export class SQLTranslator {
    private parser: any;
    private dialect: SQLDialect;

    constructor(options?: { dialect?: SQLDialect }) {
        this.dialect = options?.dialect || 'PostgreSQL';
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
            ast = this.parser.astify(trimmed, { database: this.dialect });
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

        // Check for COUNT(*)/aggregate functions, or GROUP BY / HAVING —
        // both are meaningless outside the aggregate path, so a query like
        // `SELECT status FROM t GROUP BY status HAVING COUNT(*) > 2` (no
        // aggregate function in the SELECT list itself) must still route
        // here, or GROUP BY/HAVING would be silently dropped entirely.
        if (this.hasAggregates(ast.columns) || ast.groupby || ast.having) {
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
        // node-sql-parser's INSERT column list is a plain string array under
        // MySQL dialect but an array of {type,value} objects under
        // PostgreSQL — extractColumnName() already handles both shapes
        // (it's used for the identical column_ref dialect split elsewhere).
        const columns: string[] = ast.columns ? ast.columns.map((c: any) => this.extractColumnName(c)) : [];
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

        // GROUP BY — node-sql-parser wraps the column list as
        // `{columns: [...]}` (both dialects), not a bare array; each entry
        // is a `column_ref` node in the same dialect-split shape used
        // elsewhere, so extractColumnName() already handles both.
        const groupBy: string[] = [];
        const groupByColumns = ast.groupby?.columns;
        if (Array.isArray(groupByColumns)) {
            for (const g of groupByColumns) {
                const col = this.extractColumnName(g);
                if (col !== 'unknown') groupBy.push(col);
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

        // HAVING — rewrite any aggregate-function reference (e.g. `SUM(total)`)
        // into a plain column reference pointing at that aggregate's alias
        // *before* translating, so translateWhere()'s existing binary-expr
        // logic can build a normal Filter keyed by the alias that
        // executeAggregation() will actually compute into each result row.
        if (ast.having) {
            const originalAliases = new Set(aggregates.map(a => a.alias));
            this.resolveHavingAggregates(ast.having, aggregates);
            const havingOnlyAliases = aggregates
                .filter(a => !originalAliases.has(a.alias))
                .map(a => a.alias);
            if (havingOnlyAliases.length > 0) {
                result.aggregation!.havingOnlyAliases = havingOnlyAliases;
            }
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
            case 'column_ref': {
                // Every call site here (INSERT values, UPDATE SET values,
                // WHERE comparisons, IN-list entries) expects a literal — a
                // bare identifier can't legitimately appear in any of these
                // positions. The far more common cause is a double-quoted
                // string: under the hardcoded PostgreSQL dialect, double
                // quotes denote an identifier, not a string literal (single
                // quotes do), so `"Alice"` parses as a column reference
                // named Alice rather than the string "Alice". Silently
                // stringifying that reference used to store garbage data
                // (`"$Alice"`) with no indication anything went wrong — fail
                // loudly instead, with a message that explains the actual
                // fix (use single quotes).
                const name = this.extractColumnName(node);
                throw new DocumentStoreError(
                    ErrorCodes.BadValue,
                    `SQL parse error: "${name}" was parsed as a column reference, not a value. If you meant a string literal, use single quotes ('${name}') — double quotes denote an identifier in this SQL dialect.`,
                    'BadValue',
                );
            }
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

    /**
     * Walks a HAVING clause's AST looking for aggregate-function nodes
     * (`{type:'aggr_func', name:'SUM', args:{...}}`) and rewrites each one
     * in place into a plain `column_ref` pointing at that aggregate's
     * alias — reusing an existing entry in `aggregates` if the same
     * function+field is already selected, or appending a new one so it
     * still gets computed even when HAVING references an aggregate that
     * isn't in the SELECT list. Mutates `node` and `aggregates` directly.
     */
    private resolveHavingAggregates(node: any, aggregates: AggregateFunction[]): void {
        if (!node || typeof node !== 'object') return;

        if (node.type === 'aggr_func') {
            const argField = node.args?.expr ? this.extractColumnName(node.args.expr) : '*';
            const fnType = String(node.name).toUpperCase() as AggregateFunction['type'];
            let match = aggregates.find(a => a.type === fnType && a.field === argField);
            if (!match) {
                match = { type: fnType, field: argField, alias: `${node.name}(${argField})` };
                aggregates.push(match);
            }
            node.type = 'column_ref';
            node.column = match.alias;
            return;
        }

        for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
                for (const item of value) this.resolveHavingAggregates(item, aggregates);
            } else if (value && typeof value === 'object') {
                this.resolveHavingAggregates(value, aggregates);
            }
        }
    }
}

// ---- Aggregation Execution ----
//
// Shared by every consumer of a translated 'aggregate' query (pg-server.ts,
// mysql-server.ts, and the /api/v1/sql HTTP endpoint) so `COUNT`/`SUM`/`AVG`/
// `MIN`/`MAX` behave identically regardless of which protocol the query
// arrived over.

/**
 * Executes a translated AggregationPlan against an in-memory document set
 * (already filtered by the plan's WHERE clause via `store.find()`).
 */
export function executeAggregation(
    docs: DocumentWithId[],
    plan: AggregationPlan,
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

    // HAVING — filters on the aggregated rows themselves (post-grouping),
    // unlike WHERE which filters the source documents before grouping.
    let filtered = plan.having ? results.filter(row => matchesFilter(row, plan.having!)) : results;

    // Drop any aggregate that was only computed to evaluate HAVING and
    // wasn't actually requested in the SELECT list.
    if (plan.havingOnlyAliases?.length) {
        filtered = filtered.map(row => {
            const visible = { ...row };
            for (const alias of plan.havingOnlyAliases!) delete visible[alias];
            return visible;
        });
    }

    return filtered;
}
