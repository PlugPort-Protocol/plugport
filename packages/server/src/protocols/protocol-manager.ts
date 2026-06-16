// PlugPort Protocol Manager
// Central coordinator that manages which protocol frontends are active.
// Supports runtime enable/disable via dashboard or API.

import type { ProtocolType, ProtocolConfig, ProtocolInfo } from '@plugport/shared';
import type { DocumentStore } from '../storage/document-store.js';
import type { MetricsCollector } from '../metrics.js';
import type { KVAdapter } from '@plugport/shared';
import type net from 'net';

// ---- Types ----

export interface ProtocolServerInstance {
    name: ProtocolType;
    server: net.Server | null;
    port: number;
    connections: number;
    start(): Promise<void>;
    stop(): Promise<void>;
    getConnectionCount(): number;
}

export interface ProtocolManagerOptions {
    store: DocumentStore;
    metrics: MetricsCollector;
    kvStore: KVAdapter & { getKeyCount(): number; getEstimatedSizeBytes(): number };
    apiKey?: string;
    host: string;
}

// ---- Protocol Manager ----

/**
 * Manages lifecycle of all protocol frontend servers.
 * Supports runtime enable/disable for the dashboard.
 */
export class ProtocolManager {
    private protocols: Map<ProtocolType, ProtocolServerInstance> = new Map();
    private options: ProtocolManagerOptions;

    constructor(options: ProtocolManagerOptions) {
        this.options = options;
    }

    /**
     * Register a protocol server (does not start it).
     */
    register(protocol: ProtocolServerInstance): void {
        this.protocols.set(protocol.name, protocol);
    }

    /**
     * Start a specific protocol.
     */
    async enableProtocol(name: ProtocolType): Promise<void> {
        const protocol = this.protocols.get(name);
        if (!protocol) {
            throw new Error(`Unknown protocol: ${name}`);
        }
        await protocol.start();
    }

    /**
     * Stop a specific protocol.
     */
    async disableProtocol(name: ProtocolType): Promise<void> {
        const protocol = this.protocols.get(name);
        if (!protocol) {
            throw new Error(`Unknown protocol: ${name}`);
        }
        await protocol.stop();
    }

    /**
     * Start all registered protocols that are enabled in config.
     */
    async startAll(configs: Record<ProtocolType, ProtocolConfig>): Promise<void> {
        for (const [name, config] of Object.entries(configs) as [ProtocolType, ProtocolConfig][]) {
            if (config.enabled && this.protocols.has(name)) {
                await this.enableProtocol(name);
            }
        }
    }

    /**
     * Get status of all registered protocols.
     */
    getActiveProtocols(): ProtocolInfo[] {
        const result: ProtocolInfo[] = [];

        for (const [name, protocol] of this.protocols) {
            result.push({
                name,
                enabled: protocol.server !== null,
                port: protocol.port,
                connections: protocol.getConnectionCount(),
                connectionString: this.buildConnectionString(name, protocol.port),
            });
        }

        return result;
    }

    /**
     * Check if a specific protocol is running.
     */
    isEnabled(name: ProtocolType): boolean {
        const protocol = this.protocols.get(name);
        return protocol ? protocol.server !== null : false;
    }

    /**
     * Gracefully shutdown all protocols.
     */
    async shutdown(): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const [, protocol] of this.protocols) {
            if (protocol.server !== null) {
                promises.push(protocol.stop());
            }
        }
        await Promise.allSettled(promises);
    }

    /**
     * Build a user-friendly connection string for a protocol.
     */
    private buildConnectionString(name: ProtocolType, port: number): string {
        const host = this.options.host === '0.0.0.0' ? 'localhost' : this.options.host;

        switch (name) {
            case 'mongodb':
                return `mongodb://${host}:${port}`;
            case 'postgresql':
                return `postgresql://${host}:${port}/plugport`;
            case 'mysql':
                return `mysql -h ${host} -P ${port}`;
            case 'redis':
                return `redis://${host}:${port}`;
            case 'http':
                return `http://${host}:${port}`;
            default:
                return `${name}://${host}:${port}`;
        }
    }
}
