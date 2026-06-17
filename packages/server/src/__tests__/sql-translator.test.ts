// SQL Translator Tests
// Tests SQL parsing, WHERE clause translation, and DocumentStore operation mapping

import { describe, it, expect } from 'vitest';
import { SQLTranslator } from '../protocols/sql-translator.js';

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
