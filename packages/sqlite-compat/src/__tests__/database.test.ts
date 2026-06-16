// SQLite Compat SDK Tests
// Tests the better-sqlite3 compatible API (prepare/run/get/all, transactions, pragmas)

import { describe, it, expect } from 'vitest';
import { Database } from '../index.js';

describe('Database (SQLite Compat)', () => {
    describe('Constructor', () => {
        it('should create a database with URL', () => {
            const db = new Database('http://localhost:8080');
            expect(db.name).toBe('http://localhost:8080');
            expect(db.open).toBe(true);
        });

        it('should create a database with :memory:', () => {
            const db = new Database(':memory:');
            expect(db.name).toBe(':memory:');
            expect(db.memory).toBe(true);
        });

        it('should accept API key option', () => {
            const db = new Database('http://localhost:8080', { apiKey: 'test-key' });
            expect(db.open).toBe(true);
        });
    });

    describe('Pragma', () => {
        it('should return journal_mode as wal', () => {
            const db = new Database(':memory:');
            const result = db.pragma('journal_mode', { simple: true });
            expect(result).toBe('wal');
        });

        it('should return foreign_keys as 1', () => {
            const db = new Database(':memory:');
            const result = db.pragma('foreign_keys', { simple: true });
            expect(result).toBe(1);
        });

        it('should handle SET pragmas', () => {
            const db = new Database(':memory:');
            const result = db.pragma('journal_mode = wal', { simple: true });
            expect(result).toBe('wal');
        });

        it('should return array for non-simple mode', () => {
            const db = new Database(':memory:');
            const result = db.pragma('journal_mode');
            expect(Array.isArray(result)).toBe(true);
        });
    });

    describe('Transaction', () => {
        it('should create a transaction wrapper', () => {
            const db = new Database(':memory:');
            const fn = db.transaction((...args: unknown[]) => {
                return args[0];
            });
            expect(typeof fn).toBe('function');
            expect(typeof fn.deferred).toBe('function');
            expect(typeof fn.immediate).toBe('function');
            expect(typeof fn.exclusive).toBe('function');
        });

        it('should execute the transaction function', () => {
            const db = new Database(':memory:');
            const fn = db.transaction((val: number) => val * 2);
            expect(fn(5)).toBe(10);
        });
    });

    describe('Prepare', () => {
        it('should return a statement object', () => {
            const db = new Database(':memory:');
            const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
            expect(stmt.source).toBe('SELECT * FROM users WHERE id = ?');
            expect(stmt.reader).toBe(true);
        });

        it('should detect reader vs writer statements', () => {
            const db = new Database(':memory:');
            expect(db.prepare('SELECT * FROM users').reader).toBe(true);
            expect(db.prepare("INSERT INTO users VALUES ('a')").reader).toBe(false);
            expect(db.prepare("UPDATE users SET name = 'a'").reader).toBe(false);
            expect(db.prepare("DELETE FROM users").reader).toBe(false);
        });

        it('should support bind', () => {
            const db = new Database(':memory:');
            const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
            const bound = stmt.bind(1);
            expect(bound.source).toBe('SELECT * FROM users WHERE id = ?');
        });

        it('should support columns()', () => {
            const db = new Database(':memory:');
            const stmt = db.prepare('SELECT name, email FROM users');
            const cols = stmt.columns();
            // Parser may or may not extract columns, but should not throw
            expect(Array.isArray(cols)).toBe(true);
        });
    });

    describe('Close', () => {
        it('should set open to false', () => {
            const db = new Database(':memory:');
            expect(db.open).toBe(true);
            db.close();
            expect(db.open).toBe(false);
        });
    });

    describe('Function and aggregate', () => {
        it('should accept user-defined functions (no-op)', () => {
            const db = new Database(':memory:');
            const result = db.function('custom', (x: unknown) => x);
            expect(result).toBe(db); // Chainable
        });

        it('should accept aggregates (no-op)', () => {
            const db = new Database(':memory:');
            const result = db.aggregate('custom_agg', { start: 0, step: () => {} });
            expect(result).toBe(db);
        });
    });

    describe('loadExtension', () => {
        it('should be a no-op', () => {
            const db = new Database(':memory:');
            const result = db.loadExtension('/fake/path');
            expect(result).toBe(db);
        });
    });
});
