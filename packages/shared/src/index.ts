// PlugPort Shared Types
// MongoDB-compatible type definitions for the entire PlugPort ecosystem

// ---- Document Types ----

export type ObjectId = string;

export interface Document {
    _id?: ObjectId;
    [key: string]: unknown;
}

export interface DocumentWithId extends Document {
    _id: ObjectId;
}

// ---- Filter Types ----

export interface ComparisonOperators {
    $gt?: unknown;
    $gte?: unknown;
    $lt?: unknown;
    $lte?: unknown;
    $eq?: unknown;
    $ne?: unknown;
    $in?: unknown[];
}

export type FilterValue = unknown | ComparisonOperators;

export interface Filter {
    [field: string]: FilterValue;
    $and?: Filter[];
}

// ---- Projection & Sort ----

export interface Projection {
    [field: string]: 0 | 1;
}

export interface SortSpec {
    [field: string]: 1 | -1;
}

// ---- Index Types ----

export interface IndexDefinition {
    name: string;
    field: string;
    unique: boolean;
}

export interface CollectionMetadata {
    name: string;
    indexes: IndexDefinition[];
    options: {
        createdAt: number;
        schemaVersion: number;
    };
    documentCount: number;
}

// ---- Command Types ----

export interface InsertCommand {
    type: 'insert';
    collection: string;
    documents: Document[];
}

export interface FindCommand {
    type: 'find';
    collection: string;
    filter: Filter;
    projection?: Projection;
    sort?: SortSpec;
    limit?: number;
    skip?: number;
}

export interface UpdateCommand {
    type: 'update';
    collection: string;
    filter: Filter;
    update: { $set?: Record<string, unknown> };
    upsert?: boolean;
    multi?: boolean;
}

export interface DeleteCommand {
    type: 'delete';
    collection: string;
    filter: Filter;
    multi?: boolean;
}

export interface CreateIndexCommand {
    type: 'createIndex';
    collection: string;
    field: string;
    unique?: boolean;
}

export type Command = InsertCommand | FindCommand | UpdateCommand | DeleteCommand | CreateIndexCommand;

// ---- Response Types ----

export interface InsertResult {
    acknowledged: boolean;
    insertedId?: ObjectId;
    insertedIds?: ObjectId[];
    insertedCount: number;
}

export interface FindResult {
    cursor: {
        firstBatch: DocumentWithId[];
        id: number;
    };
    ok: number;
}

export interface UpdateResult {
    acknowledged: boolean;
    matchedCount: number;
    modifiedCount: number;
    upsertedId: ObjectId | null;
}

export interface DeleteResult {
    acknowledged: boolean;
    deletedCount: number;
}

export interface CreateIndexResult {
    acknowledged: boolean;
    indexName: string;
}

export interface ErrorResult {
    ok: number;
    code: number;
    errmsg: string;
    codeName?: string;
}

export interface HealthResult {
    status: 'ok' | 'degraded' | 'error';
    uptime: number;
    version: string;
    storage: {
        type: string;
        connected: boolean;
        keyCount: number;
    };
    server: {
        httpPort: number;
        wirePort: number;
    };
}

export interface CollectionListResult {
    collections: Array<{
        name: string;
        documentCount: number;
        indexCount: number;
        createdAt: number;
    }>;
    ok: number;
}

// ---- Metrics Types ----

export interface MetricsSnapshot {
    requests: {
        total: number;
        byCommand: Record<string, number>;
        byProtocol: { http: number; wire: number };
    };
    latency: {
        p50: number;
        p95: number;
        p99: number;
        avg: number;
    };
    errors: {
        total: number;
        byCode: Record<number, number>;
    };
    storage: {
        keyCount: number;
        estimatedSizeBytes: number;
    };
    uptime: number;
    timestamp: number;
}

// ---- KV Adapter Interface ----

export interface KVEntry {
    key: string;
    value: Buffer | Uint8Array;
}

export interface ScanOptions {
    prefix?: string;
    startKey?: string;
    endKey?: string;
    limit?: number;
    reverse?: boolean;
}

export interface KVAdapter {
    get(key: string): Promise<Buffer | null>;
    put(key: string, value: Buffer | Uint8Array): Promise<void>;
    delete(key: string): Promise<boolean>;
    scan(options: ScanOptions): Promise<KVEntry[]>;
    has(key: string): Promise<boolean>;
    count(prefix?: string): Promise<number>;
    clear(): Promise<void>;
    batchWrite?(puts: { key: string; value: Buffer | Uint8Array }[], deletes: string[]): Promise<void>;
}

// ---- Configuration ----

export interface PlugPortConfig {
    httpPort: number;
    wirePort: number;
    host: string;
    monadRpcUrl?: string;
    monadChainId?: number;
    monadContractAddress?: string;
    apiKey?: string;
    maxDocumentSize: number;
    maxCollections: number;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    metricsEnabled: boolean;
}

export const DEFAULT_CONFIG: PlugPortConfig = {
    httpPort: 8080,
    wirePort: 27017,
    host: '0.0.0.0',
    apiKey: undefined,
    maxDocumentSize: 1024 * 1024, // 1MB
    maxCollections: 1000,
    logLevel: 'info',
    metricsEnabled: true,
};

// ---- Error Codes (MongoDB-compatible) ----

export const ErrorCodes = {
    OK: 0,
    InternalError: 1,
    BadValue: 2,
    NoSuchKey: 4,
    Unauthorized: 13,
    TypeMismatch: 14,
    InvalidLength: 21,
    CommandNotFound: 59,
    NamespaceNotFound: 26,
    IndexNotFound: 27,
    NamespaceExists: 48,
    DuplicateKey: 11000,
    DocumentValidationFailure: 121,
    InvalidBSON: 22,
    DocumentTooLarge: 10334,
    WriteConflict: 112,
    InvalidNamespace: 73,
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

// ---- Wire Protocol Constants ----

export const WireProtocol = {
    OP_REPLY: 1,
    OP_MSG: 2013,
    OP_QUERY: 2004,
    OP_COMPRESSED: 2012,
    MAX_WIRE_VERSION: 17,
    MIN_WIRE_VERSION: 0,
    HEADER_SIZE: 16,
    MAX_MESSAGE_SIZE: 48 * 1024 * 1024, // 48MB
} as const;

export const VERSION = '1.0.0';
