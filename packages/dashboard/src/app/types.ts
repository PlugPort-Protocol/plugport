// PlugPort Dashboard — Shared Types
// Shared interfaces used across multiple tab components.

export interface CollectionInfo {
    name: string;
    documentCount: number;
    indexCount: number;
    createdAt: number;
    ownerAddress?: string;
    mode?: string;
}

export interface IndexInfo {
    name: string;
    field: string;
    unique: boolean;
}

export interface MetricsData {
    requests: { total: number; byCommand: Record<string, number>; byProtocol: { http: number; wire: number } };
    latency: { p50: number; p95: number; p99: number; avg: number };
    errors: { total: number; byCode: Record<number, number> };
    storage: { keyCount: number; estimatedSizeBytes: number };
    uptime: number;
    timestamp: number;
}

export interface ProtocolInfo {
    name: string;
    enabled: boolean;
    port: number;
    connections: number;
    connectionString: string;
}

export interface ApiKeyInfo {
    hash: string;
    ownerAddress: string;
    label: string;
    createdAt: number;
    permissions: string[];
    rateLimit: number;
    active: boolean;
}

export interface KeyAnalytics {
    keyHash: string;
    totalRequests: number;
    firstSeen: number;
    lastSeen: number;
    daily: Array<{ date: string; requests: number; errors: number; avgLatencyMs: number; errorRate: number }>;
    operations: Record<string, number>;
    collections: Record<string, number>;
}

export interface UserMetrics {
    address: string;
    collections: number;
    documents: number;
    apiKeys: number;
    totalRequests: number;
}

export type TabId = 'overview' | 'collections' | 'query' | 'indexes' | 'metrics' | 'explorer' | 'protocols' | 'privacy' | 'apikeys' | 'deploy';

export type ScopeState = 'my' | 'all' | 'both';

// ---- Helpers ----

export function formatUptime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
