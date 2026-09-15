// MessageBrokerAdapter Reconnect Logic Tests
//
// Full end-to-end WebSocket reconnect behavior against a real RPC endpoint
// is verified separately via a live soak test (see TODO.md) — these tests
// cover the reconnect state machine (backoff scheduling, guards against
// duplicate scheduling, shutdown cancellation, listener re-attachment)
// without touching the network, since the constructor itself never opens
// a socket (that only happens in connect()/subscribe()).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageBrokerAdapter } from '../storage/message-broker-adapter.js';

describe('MessageBrokerAdapter reconnect logic', () => {
    const config = {
        contractAddress: '0x' + '1'.repeat(40),
        wsUrl: 'wss://example.invalid',
        rpcUrl: 'https://example.invalid',
        privateKey: 'a'.repeat(64),
        chainId: 10143,
    };

    let adapter: MessageBrokerAdapter;

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.useFakeTimers();
        adapter = new MessageBrokerAdapter(config);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    describe('scheduleReconnect backoff', () => {
        it('schedules the first attempt at the base delay (1000ms)', () => {
            const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
            (adapter as any).scheduleReconnect();
            expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
            expect(setTimeoutSpy.mock.calls[0][1]).toBe(1000);
        });

        it('doubles the delay on each successive attempt', () => {
            const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
            (adapter as any).scheduleReconnect();
            const delay1 = setTimeoutSpy.mock.calls[0][1];
            (adapter as any).reconnectTimer = null; // simulate the previous timer having fired

            (adapter as any).scheduleReconnect();
            const delay2 = setTimeoutSpy.mock.calls[1][1];
            (adapter as any).reconnectTimer = null;

            (adapter as any).scheduleReconnect();
            const delay3 = setTimeoutSpy.mock.calls[2][1];

            expect(delay1).toBe(1000);
            expect(delay2).toBe(2000);
            expect(delay3).toBe(4000);
        });

        it('caps the delay at MAX_RECONNECT_DELAY_MS (30000ms)', () => {
            const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
            // Force enough attempts that 1000 * 2^n would exceed the cap.
            (adapter as any).reconnectAttempt = 10;
            (adapter as any).scheduleReconnect();
            expect(setTimeoutSpy.mock.calls[0][1]).toBe(30000);
        });

        it('is a no-op if a reconnect is already scheduled', () => {
            const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
            (adapter as any).scheduleReconnect();
            (adapter as any).scheduleReconnect();
            (adapter as any).scheduleReconnect();
            expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('disconnect() cancels pending reconnects', () => {
        it('clears a pending reconnect timer', async () => {
            const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
            (adapter as any).scheduleReconnect();
            const timer = (adapter as any).reconnectTimer;
            expect(timer).not.toBeNull();

            await adapter.disconnect();
            expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
            expect((adapter as any).reconnectTimer).toBeNull();
        });

        it('prevents scheduleReconnect from doing anything after disconnect', async () => {
            await adapter.disconnect();
            const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
            (adapter as any).scheduleReconnect();
            expect(setTimeoutSpy).not.toHaveBeenCalled();
        });
    });

    describe('listener re-attachment', () => {
        it('attachListener reuses the same listener closure across calls (needed for reconnect re-attach)', () => {
            const onFn = vi.fn();
            const fakeContract = {
                filters: { MessagePublished: () => 'fake-filter' },
                on: onFn,
            };
            (adapter as any).readContract = fakeContract;

            const subscription = {
                channel: 'test',
                channelHash: '0xabc',
                callbacks: new Set([() => {}]),
                listener: null as any,
            };

            (adapter as any).attachListener(subscription);
            const firstListener = subscription.listener;
            expect(firstListener).toBeTypeOf('function');

            // Simulate re-attaching after a reconnect (fresh contract instance).
            const fakeContract2 = { filters: { MessagePublished: () => 'fake-filter-2' }, on: vi.fn() };
            (adapter as any).readContract = fakeContract2;
            (adapter as any).attachListener(subscription);

            expect(subscription.listener).toBe(firstListener); // same closure, not recreated
            expect(fakeContract2.on).toHaveBeenCalledWith('fake-filter-2', firstListener);
        });
    });

    describe('watchSocketHealth', () => {
        it('schedules a reconnect when the raw socket emits close', () => {
            const handlers: Record<string, (...args: any[]) => void> = {};
            const fakeSocket = {
                on: (event: string, handler: (...args: any[]) => void) => { handlers[event] = handler; },
            };
            const fakeWsProvider = { websocket: fakeSocket } as any;
            (adapter as any).wsProvider = fakeWsProvider;

            (adapter as any).watchSocketHealth(fakeWsProvider);
            expect(handlers.close).toBeTypeOf('function');

            const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
            handlers.close(1006);

            expect((adapter as any).connected).toBe(false);
            expect((adapter as any).wsProvider).toBeNull();
            expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
        });

        it('ignores a close event from a socket that has already been replaced', () => {
            const handlers: Record<string, (...args: any[]) => void> = {};
            const fakeSocket = {
                on: (event: string, handler: (...args: any[]) => void) => { handlers[event] = handler; },
            };
            const staleWsProvider = { websocket: fakeSocket } as any;
            (adapter as any).watchSocketHealth(staleWsProvider);

            // A different (newer) provider is now current — the stale one's
            // close event should be ignored, not tear down the live one.
            const currentWsProvider = {} as any;
            (adapter as any).wsProvider = currentWsProvider;

            const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
            handlers.close(1006);

            expect((adapter as any).wsProvider).toBe(currentWsProvider); // untouched
            expect(setTimeoutSpy).not.toHaveBeenCalled();
        });
    });
});
