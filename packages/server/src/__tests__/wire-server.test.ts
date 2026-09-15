// MongoDB Wire Protocol Command Handling Tests
// Tests handleCommand() directly against plain JS objects, decoupled from
// BSON/OP_MSG wire framing.

import { describe, it, expect } from 'vitest';
import { handleCommand } from '../wire-server.js';
import { DocumentStore } from '../storage/document-store.js';
import { InMemoryKVStore } from '../storage/kv-adapter.js';

describe('handleCommand', () => {
    const makeStore = () => new DocumentStore(new InMemoryKVStore());

    describe('getParameter', () => {
        it('should error for an unrecognized named parameter instead of faking success', async () => {
            const result = await handleCommand(
                makeStore(),
                { getParameter: 1, featureCompatibilityVersion: 1, $db: 'test' },
                [],
                1,
                true,
                undefined,
                new Set(),
            );
            expect(result.ok).toBe(0);
            expect(result.code).toBe(128);
            expect(result.codeName).toBe('InvalidOptions');
            expect(String(result.errmsg)).toContain('featureCompatibilityVersion');
        });

        it('should list every unrecognized parameter name when multiple are requested', async () => {
            const result = await handleCommand(
                makeStore(),
                { getParameter: 1, foo: 1, bar: 1, $db: 'test' },
                [],
                1,
                true,
                undefined,
                new Set(),
            );
            expect(result.ok).toBe(0);
            expect(String(result.errmsg)).toContain('foo');
            expect(String(result.errmsg)).toContain('bar');
        });

        it('should succeed with an empty result for getParameter: "*"', async () => {
            const result = await handleCommand(
                makeStore(),
                { getParameter: '*', $db: 'test' },
                [],
                1,
                true,
                undefined,
                new Set(),
            );
            expect(result.ok).toBe(1);
        });

        it('should succeed with an empty result for {allParameters: true}', async () => {
            const result = await handleCommand(
                makeStore(),
                { getParameter: { allParameters: true }, $db: 'test' },
                [],
                1,
                true,
                undefined,
                new Set(),
            );
            expect(result.ok).toBe(1);
        });

        it('should not treat wire-protocol metadata keys as requested parameters', async () => {
            const result = await handleCommand(
                makeStore(),
                { getParameter: 1, $db: 'test', lsid: { id: 'abc' }, comment: 'probe' },
                [],
                1,
                true,
                undefined,
                new Set(),
            );
            // No real parameter names were requested — only metadata keys.
            expect(result.ok).toBe(1);
        });
    });
});
