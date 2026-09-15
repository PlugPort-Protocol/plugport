// SQL Translator Tests
// Tests SQL parsing, WHERE clause translation, and DocumentStore operation mapping

import { describe, it, expect } from 'vitest';
import { SQLTranslator, executeAggregation } from '../protocols/sql-translator.js';
import type { DocumentWithId } from '@plugport/shared';

describe('SQLTranslator', () => {
    const translator = new SQLTranslator();

    describe('SELECT statements', () => {
        it('should translate simple SELECT *', () => {
            const result = translator.translate('SELECT * FROM users');
            expect(result.type).toBe('find');
            expect(result.collection).toBe('users');
            expect(result.filter).toEqual({});
        });

        it('should translate SELECT with WHERE equality', () => {
            const result = translator.translate("SELECT * FROM users WHERE name = 'Alice'");
            expect(result.type).toBe('find');
            expect(result.collection).toBe('users');
            expect(result.filter).toEqual({ name: 'Alice' });
        });

        it('should translate SELECT with WHERE comparison operators', () => {
            const result = translator.translate('SELECT * FROM users WHERE age > 25');
            expect(result.type).toBe('find');
            expect(result.filter).toEqual({ age: { $gt: 25 } });
        });

        it('should translate SELECT with WHERE AND', () => {
            const result = translator.translate("SELECT * FROM users WHERE age >= 18 AND status = 'active'");
            expect(result.type).toBe('find');
            expect(result.filter).toEqual({ $and: [{ age: { $gte: 18 } }, { status: 'active' }] });
        });

        it('should translate SELECT with LIMIT', () => {
            const result = translator.translate('SELECT * FROM users LIMIT 10');
            expect(result.type).toBe('find');
            expect(result.limit).toBe(10);
        });

        it('should translate SELECT with ORDER BY', () => {
            const result = translator.translate('SELECT * FROM users ORDER BY name ASC');
            expect(result.type).toBe('find');
            expect(result.sort).toEqual({ name: 1 });
        });

        it('should translate SELECT with ORDER BY DESC', () => {
            const result = translator.translate('SELECT * FROM users ORDER BY age DESC');
            expect(result.sort).toEqual({ age: -1 });
        });

        it('should translate SELECT with specific columns', () => {
            const result = translator.translate('SELECT name, email FROM users');
            expect(result.type).toBe('find');
            expect(result.projection).toBeDefined();
        });

        it('should translate SELECT with IN clause', () => {
            const result = translator.translate("SELECT * FROM users WHERE role IN ('admin', 'moderator')");
            expect(result.type).toBe('find');
            expect(result.filter?.role).toEqual({ $in: ['admin', 'moderator'] });
        });

        it('should handle quoted table names', () => {
            const result = translator.translate('SELECT * FROM `user_logs`');
            expect(result.collection).toBe('user_logs');
        });
    });

    describe('INSERT statements', () => {
        it('should translate simple INSERT', () => {
            const result = translator.translate("INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')");
            expect(result.type).toBe('insert');
            expect(result.collection).toBe('users');
            expect(result.documents).toBeDefined();
            expect(result.documents!.length).toBeGreaterThanOrEqual(1);
        });

        it('should translate INSERT with numeric values', () => {
            const result = translator.translate("INSERT INTO users (name, age) VALUES ('Bob', 30)");
            expect(result.type).toBe('insert');
            expect(result.documents).toBeDefined();
            const doc = result.documents![0];
            expect(doc.name).toBe('Bob');
            expect(doc.age).toBe(30);
        });
    });

    describe('UPDATE statements', () => {
        it('should translate UPDATE with SET', () => {
            const result = translator.translate("UPDATE users SET name = 'Bob' WHERE id = 1");
            expect(result.type).toBe('update');
            expect(result.collection).toBe('users');
            expect(result.update).toEqual({ $set: { name: 'Bob' } });
            expect(result.filter).toEqual({ id: 1 });
        });

        it('should translate UPDATE with multiple SET values', () => {
            const result = translator.translate("UPDATE users SET name = 'Bob', age = 31 WHERE id = 1");
            expect(result.type).toBe('update');
            expect(result.update?.$set).toHaveProperty('name', 'Bob');
            expect(result.update?.$set).toHaveProperty('age', 31);
        });
    });

    describe('DELETE statements', () => {
        it('should translate DELETE', () => {
            const result = translator.translate("DELETE FROM users WHERE id = 1");
            expect(result.type).toBe('delete');
            expect(result.collection).toBe('users');
            expect(result.filter).toEqual({ id: 1 });
        });

        it('should translate DELETE without WHERE (delete all)', () => {
            const result = translator.translate("DELETE FROM users");
            expect(result.type).toBe('delete');
            expect(result.filter).toEqual({});
        });
    });

    describe('DDL statements', () => {
        it('should translate CREATE TABLE', () => {
            const result = translator.translate('CREATE TABLE users (id INT, name VARCHAR(255))');
            expect(result.type).toBe('createCollection');
            expect(result.collection).toBe('users');
        });

        it('should translate DROP TABLE', () => {
            const result = translator.translate('DROP TABLE users');
            expect(result.type).toBe('dropCollection');
            expect(result.collection).toBe('users');
        });

        it('should translate CREATE INDEX', () => {
            const result = translator.translate('CREATE INDEX idx_email ON users (email)');
            expect(result.type).toBe('createIndex');
            expect(result.collection).toBe('users');
            expect(result.indexField).toBe('email');
        });

        it('should translate CREATE UNIQUE INDEX', () => {
            const result = translator.translate('CREATE UNIQUE INDEX idx_email ON users (email)');
            expect(result.type).toBe('createIndex');
            expect(result.indexUnique).toBe(true);
        });
    });

    describe('SHOW / DESCRIBE', () => {
        it('should translate SHOW TABLES', () => {
            const result = translator.translate('SHOW TABLES');
            expect(result.type).toBe('listCollections');
        });
    });

    describe('JOIN detection', () => {
        it('should detect INNER JOIN', () => {
            const result = translator.translate('SELECT u.name, o.total FROM users u INNER JOIN orders o ON u.id = o.user_id');
            expect(result.type).toBe('join');
            expect(result.joinType).toBe('INNER');
        });

        it('should detect LEFT JOIN', () => {
            const result = translator.translate('SELECT * FROM users u LEFT JOIN orders o ON u.id = o.user_id');
            expect(result.type).toBe('join');
            expect(result.joinType).toBe('LEFT');
        });
    });

    describe('Aggregate translation', () => {
        it('should translate COUNT(*) to an aggregate query', () => {
            const result = translator.translate('SELECT COUNT(*) FROM orders');
            expect(result.type).toBe('aggregate');
            expect(result.collection).toBe('orders');
            expect(result.aggregation?.aggregates).toEqual([
                { type: 'COUNT', field: '*', alias: 'COUNT(*)' },
            ]);
        });

        it('should translate SUM/AVG with GROUP BY and an alias', () => {
            const result = translator.translate(
                'SELECT status, SUM(total) AS total_sum, AVG(total) FROM orders GROUP BY status'
            );
            expect(result.type).toBe('aggregate');
            expect(result.aggregation?.groupBy).toEqual(['status']);
            expect(result.aggregation?.aggregates).toEqual([
                { type: 'SUM', field: 'total', alias: 'total_sum' },
                { type: 'AVG', field: 'total', alias: 'AVG(total)' },
            ]);
        });

        it('should carry a WHERE clause into the aggregate filter', () => {
            const result = translator.translate("SELECT COUNT(*) FROM orders WHERE status = 'paid'");
            expect(result.type).toBe('aggregate');
            expect(result.filter).toEqual({ status: 'paid' });
        });

        it('should translate a HAVING clause referencing a selected aggregate', () => {
            const result = translator.translate(
                'SELECT status, SUM(total) AS total_sum FROM orders GROUP BY status HAVING SUM(total) > 100'
            );
            expect(result.type).toBe('aggregate');
            expect(result.aggregation?.having).toEqual({ total_sum: { $gt: 100 } });
            // Referenced the already-selected aggregate — no extra hidden alias needed.
            expect(result.aggregation?.havingOnlyAliases).toBeUndefined();
            expect(result.aggregation?.aggregates).toEqual([
                { type: 'SUM', field: 'total', alias: 'total_sum' },
            ]);
        });

        it('should compute a HAVING aggregate not present in the SELECT list, marked hidden', () => {
            const result = translator.translate(
                'SELECT status FROM orders GROUP BY status HAVING COUNT(*) > 2'
            );
            expect(result.aggregation?.having).toEqual({ 'COUNT(*)': { $gt: 2 } });
            expect(result.aggregation?.havingOnlyAliases).toEqual(['COUNT(*)']);
            expect(result.aggregation?.aggregates).toEqual([
                { type: 'COUNT', field: '*', alias: 'COUNT(*)' },
            ]);
        });

        it('should translate a compound HAVING clause (aggregate AND grouped column)', () => {
            const result = translator.translate(
                "SELECT status, COUNT(*) FROM orders GROUP BY status HAVING COUNT(*) > 1 AND status = 'paid'"
            );
            expect(result.aggregation?.having).toEqual({
                $and: [{ 'COUNT(*)': { $gt: 1 } }, { status: 'paid' }],
            });
        });
    });

    describe('Edge cases', () => {
        it('should handle PRAGMA (no-op)', () => {
            const result = translator.translate('PRAGMA table_info(users)');
            expect(result.type).toBe('noop');
        });

        it('should handle BEGIN/COMMIT/ROLLBACK', () => {
            expect(translator.translate('BEGIN').type).toBe('noop');
            expect(translator.translate('COMMIT').type).toBe('noop');
            expect(translator.translate('ROLLBACK').type).toBe('noop');
        });

        it('should handle empty statements', () => {
            const result = translator.translate('');
            expect(result.type).toBe('noop');
        });
    });
});

describe('executeAggregation', () => {
    const docs: DocumentWithId[] = [
        { _id: '1', status: 'paid', total: 10 },
        { _id: '2', status: 'paid', total: 20 },
        { _id: '3', status: 'pending', total: 5 },
    ] as unknown as DocumentWithId[];

    it('computes COUNT(*) with no GROUP BY as a single row', () => {
        const rows = executeAggregation(docs, {
            groupBy: [],
            aggregates: [{ type: 'COUNT', field: '*', alias: 'count' }],
        });
        expect(rows).toEqual([{ count: 3 }]);
    });

    it('computes SUM/AVG/MIN/MAX with no GROUP BY', () => {
        const rows = executeAggregation(docs, {
            groupBy: [],
            aggregates: [
                { type: 'SUM', field: 'total', alias: 'sum' },
                { type: 'AVG', field: 'total', alias: 'avg' },
                { type: 'MIN', field: 'total', alias: 'min' },
                { type: 'MAX', field: 'total', alias: 'max' },
            ],
        });
        expect(rows).toEqual([{ sum: 35, avg: 35 / 3, min: 5, max: 20 }]);
    });

    it('groups by a field and aggregates per group', () => {
        const rows = executeAggregation(docs, {
            groupBy: ['status'],
            aggregates: [
                { type: 'COUNT', field: '*', alias: 'count' },
                { type: 'SUM', field: 'total', alias: 'sum' },
            ],
        });
        const byStatus = Object.fromEntries(rows.map(r => [r.status as string, r]));
        expect(byStatus.paid).toEqual({ status: 'paid', count: 2, sum: 30 });
        expect(byStatus.pending).toEqual({ status: 'pending', count: 1, sum: 5 });
    });

    it('returns an empty array for an empty document set', () => {
        const rows = executeAggregation([], {
            groupBy: [],
            aggregates: [{ type: 'COUNT', field: '*', alias: 'count' }],
        });
        // No groups exist, but the "entire result is one group" path still
        // creates the implicit __all__ group even when it's empty.
        expect(rows).toEqual([{ count: 0 }]);
    });

    it('ignores non-numeric values in SUM without throwing', () => {
        const mixed: DocumentWithId[] = [
            { _id: '1', total: 10 },
            { _id: '2', total: 'not-a-number' },
        ] as unknown as DocumentWithId[];
        const rows = executeAggregation(mixed, {
            groupBy: [],
            aggregates: [{ type: 'SUM', field: 'total', alias: 'sum' }],
        });
        expect(rows).toEqual([{ sum: 10 }]);
    });

    describe('HAVING', () => {
        it('drops groups that fail the HAVING filter', () => {
            const rows = executeAggregation(docs, {
                groupBy: ['status'],
                aggregates: [{ type: 'SUM', field: 'total', alias: 'total_sum' }],
                having: { total_sum: { $gt: 10 } },
            });
            // paid: sum=30 (passes), pending: sum=5 (fails)
            expect(rows).toEqual([{ status: 'paid', total_sum: 30 }]);
        });

        it('keeps all groups when every one satisfies HAVING', () => {
            const rows = executeAggregation(docs, {
                groupBy: ['status'],
                aggregates: [{ type: 'COUNT', field: '*', alias: 'count' }],
                having: { count: { $gte: 1 } },
            });
            expect(rows).toHaveLength(2);
        });

        it('strips havingOnlyAliases from the final rows after filtering', () => {
            const rows = executeAggregation(docs, {
                groupBy: ['status'],
                aggregates: [{ type: 'COUNT', field: '*', alias: 'COUNT(*)' }],
                having: { 'COUNT(*)': { $gt: 1 } },
                havingOnlyAliases: ['COUNT(*)'],
            });
            // Only the "paid" group (count=2) passes; the hidden COUNT(*)
            // alias must not leak into the visible result.
            expect(rows).toEqual([{ status: 'paid' }]);
        });

        it('returns no rows when no group satisfies HAVING', () => {
            const rows = executeAggregation(docs, {
                groupBy: ['status'],
                aggregates: [{ type: 'SUM', field: 'total', alias: 'total_sum' }],
                having: { total_sum: { $gt: 1000 } },
            });
            expect(rows).toEqual([]);
        });
    });
});
