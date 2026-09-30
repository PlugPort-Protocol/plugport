// Every put on the Monad adapter is a transaction paid by the Store gas-station
// wallet. Recording analytics per request cost up to four transactions per
// request; an open dashboard (polling every 5s) sent ~750 a day and drained the
// wallet, which stopped all document writes. Analytics are now counted in memory
// and written in one batch per flush interval.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryKVStore } from '../storage/kv-adapter.js';
import { AnalyticsRecorder, type AnalyticsEvent } from '../auth/analytics-recorder.js';

const ID = 'wallet:0xb2ac1908cfb52debcca860ebcf538770e67df2b5';
const event = (over: Partial<AnalyticsEvent> = {}): AnalyticsEvent => ({
    operation: 'find', collection: 'users', latencyMs: 10, statusCode: 200, payloadBytes: 100, ...over,
});

function setup() {
    const kv = new InMemoryKVStore();
    const put = vi.spyOn(kv, 'put');
    const batchWrite = vi.spyOn(kv, 'batchWrite');
    const recorder = new AnalyticsRecorder(kv, { flushIntervalMs: 0 });
    return { kv, put, batchWrite, recorder };
}

afterEach(() => vi.useRealTimers());

describe('AnalyticsRecorder batching', () => {
    it('writes nothing per request — 100 requests cost zero writes until a flush', async () => {
        const { put, batchWrite, recorder } = setup();
        for (let i = 0; i < 100; i++) await recorder.record(ID, event());
        expect(put).not.toHaveBeenCalled();
        expect(batchWrite).not.toHaveBeenCalled();
    });

    it('includes unflushed requests in reads', async () => {
        const { recorder } = setup();
        for (let i = 0; i < 3; i++) await recorder.record(ID, event());
        await recorder.record(ID, event({ operation: 'insert', statusCode: 500 }));

        const analytics = await recorder.getAnalytics(ID, 1);
        expect(analytics.totalRequests).toBe(4);
        expect(analytics.operations).toEqual({ find: 3, insert: 1 });
        expect(analytics.collections).toEqual({ users: 4 });
        expect(analytics.daily[0]).toMatchObject({ requests: 4, errors: 1, totalLatencyMs: 40, errorRate: 0.25 });
        expect((await recorder.getOverviewForOwner([ID])).totalRequests).toBe(4);
    });

    it('writes all pending counts in one batch, and nothing when idle', async () => {
        const { batchWrite, put, recorder } = setup();
        for (let i = 0; i < 50; i++) await recorder.record(ID, event());
        await recorder.flush();
        expect(batchWrite).toHaveBeenCalledTimes(1);
        expect(batchWrite.mock.calls[0][0]).toHaveLength(4); // summary, ops, cols, lifetime
        expect(put).not.toHaveBeenCalled();

        await recorder.flush();
        expect(batchWrite).toHaveBeenCalledTimes(1);
    });

    it('adds each flush to the stored totals', async () => {
        const { recorder } = setup();
        await recorder.record(ID, event({ timestamp: 2_000 }));
        await recorder.flush();
        await recorder.record(ID, event({ timestamp: 1_000 }));
        await recorder.record(ID, event({ timestamp: 3_000, operation: 'count' }));
        await recorder.flush();

        const analytics = await recorder.getAnalytics(ID, 1);
        expect(analytics.totalRequests).toBe(3);
        expect(analytics.firstSeen).toBe(1_000);
        expect(analytics.lastSeen).toBe(3_000);
    });

    it('keeps the counts of a failed flush for the next one', async () => {
        const { batchWrite, recorder } = setup();
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        await recorder.record(ID, event());
        await recorder.record(ID, event());
        batchWrite.mockRejectedValueOnce(new Error('Signer had insufficient balance'));
        await recorder.flush();

        await recorder.record(ID, event());
        await recorder.flush();
        expect((await recorder.getAnalytics(ID, 1)).totalRequests).toBe(3);
    });

    it('flushes on its interval', async () => {
        vi.useFakeTimers();
        const kv = new InMemoryKVStore();
        const batchWrite = vi.spyOn(kv, 'batchWrite');
        const recorder = new AnalyticsRecorder(kv, { flushIntervalMs: 60_000 });
        await recorder.record(ID, event());
        await vi.advanceTimersByTimeAsync(60_000);
        expect(batchWrite).toHaveBeenCalledTimes(1);
        await recorder.close();
    });

    it('writes pending counts on close', async () => {
        const { batchWrite, recorder } = setup();
        await recorder.record(ID, event());
        await recorder.close();
        expect(batchWrite).toHaveBeenCalledTimes(1);
    });
});
