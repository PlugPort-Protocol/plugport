// PlugPort Metrics Collector
// Prometheus-compatible metrics for monitoring QPS, latency, errors, and storage

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import type { MetricsSnapshot } from '@plugport/shared';

export class MetricsCollector {
    private registry: Registry;
    private requestCounter: Counter;
    private requestLatency: Histogram;
    private errorCounter: Counter;
    private activeConnections: Gauge;
    private storageKeyCount: Gauge;
    private storageSizeBytes: Gauge;
    private startTime: number;

    // In-memory tracking for snapshot API
    private commandCounts: Record<string, number> = {};
    private protocolCounts = { http: 0, wire: 0 };
    private latencies: number[] = [];
    private errorCodes: Record<number, number> = {};

    constructor() {
        this.registry = new Registry();
        this.startTime = Date.now();

        collectDefaultMetrics({ register: this.registry });

        this.requestCounter = new Counter({
            name: 'plugport_requests_total',
            help: 'Total number of requests processed',
            labelNames: ['command', 'protocol', 'status'],
            registers: [this.registry],
        });

        this.requestLatency = new Histogram({
            name: 'plugport_request_duration_ms',
            help: 'Request latency in milliseconds',
            labelNames: ['command', 'protocol'],
            buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
            registers: [this.registry],
        });

        this.errorCounter = new Counter({
            name: 'plugport_errors_total',
            help: 'Total number of errors',
            labelNames: ['code', 'command'],
            registers: [this.registry],
        });

        this.activeConnections = new Gauge({
            name: 'plugport_active_connections',
            help: 'Number of active connections',
            labelNames: ['protocol'],
            registers: [this.registry],
        });

        this.storageKeyCount = new Gauge({
            name: 'plugport_storage_keys_total',
            help: 'Total number of keys in storage',
            registers: [this.registry],
        });

        this.storageSizeBytes = new Gauge({
            name: 'plugport_storage_size_bytes',
            help: 'Estimated storage size in bytes',
            registers: [this.registry],
        });
    }

    recordRequest(command: string, protocol: 'http' | 'wire', durationMs: number, success: boolean): void {
        this.requestCounter.inc({ command, protocol, status: success ? 'ok' : 'error' });
        this.requestLatency.observe({ command, protocol }, durationMs);

        // In-memory tracking
        const MAX_TRACKED_COMMANDS = 100;
        let trackingCommand = command;

        if (
            !this.commandCounts[command] &&
            Object.keys(this.commandCounts).length >= MAX_TRACKED_COMMANDS
        ) {
            trackingCommand = 'unknown_or_overflow';
        }

        this.commandCounts[trackingCommand] = (this.commandCounts[trackingCommand] || 0) + 1;
        this.protocolCounts[protocol]++;
        this.latencies.push(durationMs);

        // Keep only last 10000 latencies for percentile calculation
        if (this.latencies.length > 10000) {
            this.latencies = this.latencies.slice(-10000);
        }
    }

    recordError(code: number, command: string): void {
        this.errorCounter.inc({ code: String(code), command });

        const MAX_TRACKED_ERRORS = 100;
        let trackingCode = code;

        if (
            !this.errorCodes[code] &&
            Object.keys(this.errorCodes).length >= MAX_TRACKED_ERRORS
        ) {
            trackingCode = -1; // -1 represents unknown_or_overflow mapped identically
        }

        this.errorCodes[trackingCode] = (this.errorCodes[trackingCode] || 0) + 1;
    }

    connectionOpened(protocol: 'http' | 'wire'): void {
        this.activeConnections.inc({ protocol });
    }

    connectionClosed(protocol: 'http' | 'wire'): void {
        this.activeConnections.dec({ protocol });
    }

    updateStorageMetrics(keyCount: number, sizeBytes: number): void {
        this.storageKeyCount.set(keyCount);
        this.storageSizeBytes.set(sizeBytes);
    }

    async getPrometheusMetrics(): Promise<string> {
        return this.registry.metrics();
    }

    getContentType(): string {
        return this.registry.contentType;
    }

    getSnapshot(): MetricsSnapshot {
        const sorted = [...this.latencies].sort((a, b) => a - b);
        const len = sorted.length;

        return {
            requests: {
                total: Object.values(this.commandCounts).reduce((s, v) => s + v, 0),
                byCommand: { ...this.commandCounts },
                byProtocol: { ...this.protocolCounts },
            },
            latency: {
                p50: len > 0 ? sorted[Math.floor(len * 0.5)] : 0,
                p95: len > 0 ? sorted[Math.floor(len * 0.95)] : 0,
                p99: len > 0 ? sorted[Math.floor(len * 0.99)] : 0,
                avg: len > 0 ? sorted.reduce((s, v) => s + v, 0) / len : 0,
            },
            errors: {
                total: Object.values(this.errorCodes).reduce((s, v) => s + v, 0),
                byCode: { ...this.errorCodes },
            },
            storage: {
                keyCount: 0,
                estimatedSizeBytes: 0,
            },
            uptime: Date.now() - this.startTime,
            timestamp: Date.now(),
        };
    }
}
