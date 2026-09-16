// Regression tests for the SQL `LIKE` no-op bug: sql-translator.ts's LIKE
// case correctly built a `{ $regex: ... }` filter, but query-planner.ts's
// matchesComparison() had no `$regex` case at all, so the condition was
// silently dropped and every LIKE matched every row regardless of the
// pattern (found in a live QA pass — see TODO.md).

import { describe, it, expect } from 'vitest';
import { matchesFilter } from '../storage/query-planner.js';

describe('matchesFilter — $regex', () => {
    it('matches a document whose field satisfies the pattern', () => {
        expect(matchesFilter({ name: 'Alice' }, { name: { $regex: '^.*lic.*$' } })).toBe(true);
    });

    it('rejects a document whose field does not satisfy the pattern', () => {
        expect(matchesFilter({ name: 'Bob' }, { name: { $regex: '^.*lic.*$' } })).toBe(false);
    });

    it('rejects when the field is missing entirely', () => {
        expect(matchesFilter({ other: 'x' }, { name: { $regex: '^.*lic.*$' } })).toBe(false);
    });

    it('respects the $options flag (case-insensitive)', () => {
        expect(matchesFilter({ name: 'ALICE' }, { name: { $regex: '^alice$', $options: 'i' } })).toBe(true);
        expect(matchesFilter({ name: 'ALICE' }, { name: { $regex: '^alice$' } })).toBe(false);
    });

    it('fails closed (no match) on an invalid regex instead of throwing', () => {
        expect(() => matchesFilter({ name: 'Alice' }, { name: { $regex: '(unterminated' } })).not.toThrow();
        expect(matchesFilter({ name: 'Alice' }, { name: { $regex: '(unterminated' } })).toBe(false);
    });

    it('fails closed on a pattern over the length cap instead of evaluating it', () => {
        const hugePattern = '^' + 'a'.repeat(600) + '$';
        expect(matchesFilter({ name: 'a'.repeat(600) }, { name: { $regex: hugePattern } })).toBe(false);
    });

    it('coerces a non-string field value before testing', () => {
        expect(matchesFilter({ age: 42 }, { age: { $regex: '^4' } })).toBe(true);
    });

    it('a non-string $regex target is safely rejected, not thrown', () => {
        expect(matchesFilter({ name: 'Alice' }, { name: { $regex: 12345 as any } })).toBe(false);
    });
});
