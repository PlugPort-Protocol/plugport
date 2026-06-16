// JOIN Engine Tests
// Tests hash join, left/right join, cross join, and index-assisted join strategies

import { describe, it, expect } from 'vitest';
import { JoinEngine } from '../protocols/join-engine.js';
import type { DocumentWithId } from '@plugport/shared';

describe('JoinEngine', () => {
    const engine = new JoinEngine();

    // Sample data
    const users: DocumentWithId[] = [
        { _id: '1', name: 'Alice', country: 'US' },
        { _id: '2', name: 'Bob', country: 'UK' },
        { _id: '3', name: 'Charlie', country: 'US' },
    ];

    const orders: DocumentWithId[] = [
        { _id: 'o1', user_id: '1', total: 100, product: 'Widget' },
        { _id: 'o2', user_id: '1', total: 200, product: 'Gadget' },
        { _id: 'o3', user_id: '2', total: 50, product: 'Book' },
        { _id: 'o4', user_id: '99', total: 10, product: 'Orphan' },
    ];

    describe('Hash Join (INNER JOIN)', () => {
        it('should join on matching keys', () => {
            const result = engine.hashJoin(users, orders, '_id', 'user_id');
            // User 1 matches o1, o2; User 2 matches o3; User 3 has no orders
            expect(result.length).toBe(3);
        });

        it('should include fields from both sides', () => {
            const result = engine.hashJoin(users, orders, '_id', 'user_id');
            const aliceOrder = result.find(r => (r as any).name === 'Alice' && (r as any).product === 'Widget');
            expect(aliceOrder).toBeTruthy();
            expect((aliceOrder as any).total).toBe(100);
        });

        it('should return empty for no matches', () => {
            const noMatch: DocumentWithId[] = [
                { _id: '999', user_id: '999', total: 0 },
            ];
            const result = engine.hashJoin(users, noMatch, '_id', 'user_id');
            expect(result.length).toBe(0);
        });

        it('should handle empty left side', () => {
            const result = engine.hashJoin([], orders, '_id', 'user_id');
            expect(result.length).toBe(0);
        });

        it('should handle empty right side', () => {
            const result = engine.hashJoin(users, [], '_id', 'user_id');
            expect(result.length).toBe(0);
        });

        it('should handle one-to-many relationships', () => {
            // Alice has 2 orders → should produce 2 rows for Alice
            const result = engine.hashJoin(users, orders, '_id', 'user_id');
            const aliceRows = result.filter(r => (r as any).name === 'Alice');
            expect(aliceRows.length).toBe(2);
        });
    });

    describe('Left Join', () => {
        it('should include all left rows', () => {
            const result = engine.leftJoin(users, orders, '_id', 'user_id');
            // Alice: 2 orders, Bob: 1 order, Charlie: 0 orders (null)
            expect(result.length).toBe(4); // 2 + 1 + 1 (null row for Charlie)
        });

        it('should include null for unmatched left rows', () => {
            const result = engine.leftJoin(users, orders, '_id', 'user_id');
            const charlieRow = result.find(r => (r as any).name === 'Charlie');
            expect(charlieRow).toBeTruthy();
            expect((charlieRow as any).total).toBeUndefined();
        });
    });

    describe('Right Join', () => {
        it('should include all right rows', () => {
            const result = engine.rightJoin(users, orders, '_id', 'user_id');
            // Orphan order (user_id=99) should be included
            expect(result.length).toBe(4); // 2 + 1 + 1 (orphan)
        });

        it('should include null for unmatched right rows', () => {
            const result = engine.rightJoin(users, orders, '_id', 'user_id');
            const orphanRow = result.find(r => (r as any).product === 'Orphan');
            expect(orphanRow).toBeTruthy();
            expect((orphanRow as any).name).toBeUndefined();
        });
    });

    describe('Cross Join', () => {
        it('should produce cartesian product', () => {
            const smallLeft: DocumentWithId[] = [
                { _id: 's1', size: 'S' },
                { _id: 's2', size: 'M' },
            ];
            const smallRight: DocumentWithId[] = [
                { _id: 'c1', color: 'Red' },
                { _id: 'c2', color: 'Blue' },
                { _id: 'c3', color: 'Green' },
            ];
            const result = engine.crossJoin(smallLeft, smallRight);
            expect(result.length).toBe(6); // 2 × 3
        });

        it('should cap results at 10000', () => {
            // Create arrays that would produce > 10000 rows
            const bigLeft: DocumentWithId[] = Array.from({ length: 200 }, (_, i) => ({
                _id: `l${i}`,
                val: i,
            }));
            const bigRight: DocumentWithId[] = Array.from({ length: 200 }, (_, i) => ({
                _id: `r${i}`,
                val: i,
            }));
            const result = engine.crossJoin(bigLeft, bigRight);
            expect(result.length).toBeLessThanOrEqual(10000);
        });

        it('should handle empty sides', () => {
            expect(engine.crossJoin([], orders).length).toBe(0);
            expect(engine.crossJoin(users, []).length).toBe(0);
        });
    });

    describe('Multi-table join utilities', () => {
        it('should merge row fields correctly', () => {
            const result = engine.hashJoin(users, orders, '_id', 'user_id');
            for (const row of result) {
                // Each row should have fields from both tables
                expect(row).toHaveProperty('name');
                expect(row).toHaveProperty('total');
            }
        });
    });
});
