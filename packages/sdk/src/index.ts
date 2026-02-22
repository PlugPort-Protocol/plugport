// PlugPort Node.js SDK
// MongoDB-compatible client for PlugPort with full TypeScript support
// Uses HTTP API (fetch) under the hood for maximum compatibility

import type {
    Document,
    DocumentWithId,
    Filter,
    Projection,
    SortSpec,
    InsertResult,
    FindResult,
    UpdateResult,
    DeleteResult,
    CreateIndexResult,
    HealthResult,
    CollectionListResult,
    MetricsSnapshot,
} from '@plugport/shared';

// ---- HTTP Transport ----

class HttpTransport {
    constructor(private baseUrl: string, private apiKey?: string, private timeoutMs: number = 30000) { }

    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }

        const maxRetries = 3;
        const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

            try {
                const response = await fetch(`${this.baseUrl}${path}`, {
                    method,
                    headers,
                    body: body ? JSON.stringify(body) : undefined,
                    signal: controller.signal,
                });
                clearTimeout(timeoutId);

                // Handle rate limiting specifically
                if (response.status === 429 && attempt < maxRetries) {
                    await delay(Math.pow(2, attempt) * 1000);
                    continue;
                }

                if (!response.ok) {
                    const error = await response.json().catch(() => ({ errmsg: response.statusText }));
                    throw new PlugPortError(
                        (error as Record<string, unknown>).code as number || response.status,
                        (error as Record<string, unknown>).errmsg as string || 'Request failed',
                    );
                }

                return await response.json() as T;
            } catch (err: any) {
                clearTimeout(timeoutId);

                if (err.name === 'AbortError') {
                    if (attempt < maxRetries) {
                        await delay(Math.pow(2, attempt) * 1000);
                        continue;
                    }
                    throw new PlugPortError(50, `Request timed out after ${this.timeoutMs}ms`);
                }

                throw err;
            }
        }

        throw new PlugPortError(50, 'Request failed after maximum retries');
    }
}

// ---- Error Class ----

export class PlugPortError extends Error {
    constructor(
        public code: number,
        message: string,
    ) {
        super(message);
        this.name = 'PlugPortError';
    }
}

// ---- Collection ----

export class Collection<TDoc extends Document = Document> {
    constructor(
        private transport: HttpTransport,
        private collectionName: string,
    ) { }

    get name(): string {
        return this.collectionName;
    }

    /**
     * Insert a single document.
     */
    async insertOne(document: TDoc): Promise<InsertResult> {
        return this.transport.request<InsertResult>(
            'POST',
            `/api/v1/collections/${this.collectionName}/insertOne`,
            { document },
        );
    }

    /**
     * Insert multiple documents.
     */
    async insertMany(documents: TDoc[]): Promise<InsertResult> {
        return this.transport.request<InsertResult>(
            'POST',
            `/api/v1/collections/${this.collectionName}/insertMany`,
            { documents },
        );
    }

    /**
     * Find documents matching a filter.
     */
    async find(
        filter: Filter = {},
        options: { projection?: Projection; sort?: SortSpec; limit?: number; skip?: number } = {},
    ): Promise<DocumentWithId[]> {
        const result = await this.transport.request<FindResult>(
            'POST',
            `/api/v1/collections/${this.collectionName}/find`,
            { filter, ...options },
        );
        return result.cursor.firstBatch;
    }

    /**
     * Find a single document matching a filter.
     */
    async findOne(
        filter: Filter = {},
        options: { projection?: Projection } = {},
    ): Promise<DocumentWithId | null> {
        const result = await this.transport.request<{ document: DocumentWithId | null }>(
            'POST',
            `/api/v1/collections/${this.collectionName}/findOne`,
            { filter, ...options },
        );
        return result.document;
    }

    /**
     * Update a single document matching a filter.
     */
    async updateOne(
        filter: Filter,
        update: { $set?: Partial<TDoc>; $inc?: Record<string, number>; $unset?: Record<string, unknown> },
        options: { upsert?: boolean } = {},
    ): Promise<UpdateResult> {
        return this.transport.request<UpdateResult>(
            'POST',
            `/api/v1/collections/${this.collectionName}/updateOne`,
            { filter, update, ...options },
        );
    }

    /**
     * Update multiple documents matching a filter.
     */
    async updateMany(
        filter: Filter,
        update: { $set?: Partial<TDoc>; $inc?: Record<string, number>; $unset?: Record<string, unknown> },
        options: { upsert?: boolean } = {},
    ): Promise<UpdateResult> {
        return this.transport.request<UpdateResult>(
            'POST',
            `/api/v1/collections/${this.collectionName}/updateMany`,
            { filter, update, ...options },
        );
    }

    /**
     * Delete a single document matching a filter.
     */
    async deleteOne(filter: Filter): Promise<DeleteResult> {
        return this.transport.request<DeleteResult>(
            'POST',
            `/api/v1/collections/${this.collectionName}/deleteOne`,
            { filter },
        );
    }

    /**
     * Delete multiple documents matching a filter.
     */
    async deleteMany(filter: Filter): Promise<DeleteResult> {
        return this.transport.request<DeleteResult>(
            'POST',
            `/api/v1/collections/${this.collectionName}/deleteMany`,
            { filter },
        );
    }

    /**
     * Create an index on a field.
     */
    async createIndex(
        field: string,
        options: { unique?: boolean } = {},
    ): Promise<CreateIndexResult> {
        return this.transport.request<CreateIndexResult>(
            'POST',
            `/api/v1/collections/${this.collectionName}/createIndex`,
            { field, ...options },
        );
    }

    /**
     * Drop an index by name.
     */
    async dropIndex(indexName: string): Promise<{ acknowledged: boolean; dropped: boolean }> {
        return this.transport.request(
            'POST',
            `/api/v1/collections/${this.collectionName}/dropIndex`,
            { indexName },
        );
    }

    /**
     * List indexes on this collection.
     */
    async listIndexes(): Promise<{ indexes: Array<{ name: string; field: string; unique: boolean }> }> {
        return this.transport.request(
            'GET',
            `/api/v1/collections/${this.collectionName}/indexes`,
        );
    }

    /**
     * Get collection statistics.
     */
    async stats(): Promise<{ documentCount: number; indexCount: number; storageSizeBytes: number }> {
        return this.transport.request(
            'GET',
            `/api/v1/collections/${this.collectionName}/stats`,
        );
    }

    /**
     * Drop this collection.
     */
    async drop(): Promise<{ acknowledged: boolean; dropped: boolean }> {
        return this.transport.request(
            'POST',
            `/api/v1/collections/${this.collectionName}/drop`,
        );
    }

    /**
     * Count documents matching a filter (server-side).
     */
    async countDocuments(filter: Filter = {}): Promise<number> {
        const result = await this.transport.request<{ count: number }>(
            'POST',
            `/api/v1/collections/${this.collectionName}/count`,
            { filter },
        );
        return result.count;
    }

    /**
     * Get distinct values for a field.
     */
    async distinct(field: string, filter: Filter = {}): Promise<unknown[]> {
        const result = await this.transport.request<{ values: unknown[] }>(
            'POST',
            `/api/v1/collections/${this.collectionName}/distinct`,
            { field, filter },
        );
        return result.values;
    }
}

// ---- Database ----

export class Database {
    constructor(
        private transport: HttpTransport,
        private dbName: string,
    ) { }

    get name(): string {
        return this.dbName;
    }

    /**
     * Get a collection reference.
     */
    collection<TDoc extends Document = Document>(name: string): Collection<TDoc> {
        return new Collection<TDoc>(this.transport, name);
    }

    /**
     * List all collections.
     */
    async listCollections(): Promise<CollectionListResult> {
        return this.transport.request<CollectionListResult>('GET', '/api/v1/collections');
    }

    /**
     * Drop a collection.
     */
    async dropCollection(name: string): Promise<boolean> {
        const result = await this.transport.request<{ dropped: boolean }>(
            'POST',
            `/api/v1/collections/${name}/drop`,
        );
        return result.dropped;
    }
}

// ---- Client ----

export class PlugPortClient {
    private transport: HttpTransport;
    private _connected = false;

    private constructor(
        private uri: string,
        private options: PlugPortClientOptions = {},
    ) {
        // Parse URI: plugport://host:port or http://host:port
        let baseUrl = uri;
        if (uri.startsWith('plugport://')) {
            baseUrl = uri.replace('plugport://', 'http://');
        }
        // Remove trailing slash
        baseUrl = baseUrl.replace(/\/+$/, '');

        this.transport = new HttpTransport(baseUrl, options.apiKey, options.timeout);
    }

    /**
     * Connect to a PlugPort server.
     */
    static async connect(uri: string, options: PlugPortClientOptions = {}): Promise<PlugPortClient> {
        const client = new PlugPortClient(uri, options);

        // Verify connection
        try {
            await client.health();
            client._connected = true;
        } catch (err) {
            throw new PlugPortError(0, `Failed to connect to ${uri}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }

        return client;
    }

    /**
     * Get a database reference.
     */
    db(name: string = 'default'): Database {
        return new Database(this.transport, name);
    }

    /**
     * Get health status.
     */
    async health(): Promise<HealthResult> {
        return this.transport.request<HealthResult>('GET', '/health');
    }

    /**
     * Get metrics snapshot.
     */
    async metrics(): Promise<MetricsSnapshot> {
        return this.transport.request<MetricsSnapshot>('GET', '/api/v1/metrics');
    }

    /**
     * Check if connected.
     */
    get isConnected(): boolean {
        return this._connected;
    }

    /**
     * Close the client connection.
     */
    async close(): Promise<void> {
        this._connected = false;
    }
}

// ---- Options ----

export interface PlugPortClientOptions {
    apiKey?: string;
    timeout?: number;
}

// ---- Re-exports ----

export type {
    Document,
    DocumentWithId,
    Filter,
    Projection,
    SortSpec,
    InsertResult,
    FindResult,
    UpdateResult,
    DeleteResult,
    CreateIndexResult,
    HealthResult,
    MetricsSnapshot,
} from '@plugport/shared';

// Default export
export default PlugPortClient;
