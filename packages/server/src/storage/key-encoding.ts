// PlugPort Key Encoding
// Provides deterministic, sort-order-preserving encoding for KV keys
// Keys follow the pattern: prefix:collection:field:encodedValue:_id

/**
 * Encode a document storage key.
 * Pattern: doc:{collection}:{_id}
 */
export function encodeDocKey(collection: string, id: string): string {
    return `doc:${collection}:${id}`;
}

/**
 * Decode a document storage key.
 */
export function decodeDocKey(key: string): { collection: string; id: string } | null {
    const parts = key.split(':');
    if (parts[0] !== 'doc' || parts.length < 3) return null;
    return { collection: parts[1], id: parts.slice(2).join(':') };
}

/**
 * Internal separator between encoded value and doc ID in index keys.
 * Using Unit Separator (\x1F) to avoid conflicts with `:` in encoded values.
 */
const IDX_ID_SEP = '\x1F';

/**
 * Encode an index entry key.
 * Pattern: idx:{collection}:{field}:{encodedValue}\x00{_id}
 * The null byte separator ensures doc IDs parse correctly even when
 * encoded values contain `:` (e.g., `3:alice` for string "alice").
 */
export function encodeIdxKey(collection: string, field: string, value: unknown, id: string): string {
    const encodedValue = encodeValue(value);
    return `idx:${collection}:${field}:${encodedValue}${IDX_ID_SEP}${id}`;
}

/**
 * Decode an index entry key.
 */
export function decodeIdxKey(key: string): {
    collection: string;
    field: string;
    encodedValue: string;
    id: string;
} | null {
    // First 3 parts are always: idx, collection, field
    const firstColon = key.indexOf(':');
    if (firstColon === -1 || key.substring(0, firstColon) !== 'idx') return null;

    const secondColon = key.indexOf(':', firstColon + 1);
    if (secondColon === -1) return null;

    const thirdColon = key.indexOf(':', secondColon + 1);
    if (thirdColon === -1) return null;

    const collection = key.substring(firstColon + 1, secondColon);
    const field = key.substring(secondColon + 1, thirdColon);

    // The rest is encodedValue\x00docId
    const rest = key.substring(thirdColon + 1);
    const sepIdx = rest.lastIndexOf(IDX_ID_SEP);
    if (sepIdx === -1) return null;

    return {
        collection,
        field,
        encodedValue: rest.substring(0, sepIdx),
        id: rest.substring(sepIdx + 1),
    };
}

/**
 * Encode a collection metadata key.
 * Pattern: meta:collection:{name}
 */
export function encodeMetaKey(collection: string): string {
    return `meta:collection:${collection}`;
}

/**
 * Decode a collection metadata key.
 */
export function decodeMetaKey(key: string): string | null {
    const parts = key.split(':');
    if (parts[0] !== 'meta' || parts[1] !== 'collection' || parts.length < 3) return null;
    return parts.slice(2).join(':');
}

/**
 * Encode a system metadata key.
 * Pattern: meta:system:{name}
 */
export function encodeSystemMetaKey(name: string): string {
    return `meta:system:${name}`;
}

/**
 * Get the prefix for scanning all documents in a collection.
 * Returns: doc:{collection}:
 */
export function docPrefix(collection: string): string {
    return `doc:${collection}:`;
}

/**
 * Get the prefix for scanning all index entries for a field.
 * Returns: idx:{collection}:{field}:
 */
export function idxPrefix(collection: string, field: string): string {
    return `idx:${collection}:${field}:`;
}

/**
 * Get the prefix for scanning all index entries in a collection.
 */
export function idxCollectionPrefix(collection: string): string {
    return `idx:${collection}:`;
}

/**
 * Get the prefix for scanning all collection metadata.
 */
export function metaPrefix(): string {
    return `meta:collection:`;
}

// ---- Value Encoding ----
// Values are encoded in a sort-order-preserving format.
// Type prefixes ensure correct cross-type ordering:
//   0: null
//   1: boolean
//   2: number
//   3: string
//   4: date

/**
 * Encode a value in sort-order-preserving format.
 * The encoding preserves lexicographic ordering for range scans.
 */
export function encodeValue(value: unknown): string {
    if (value === null || value === undefined) {
        return '0:';
    }

    if (typeof value === 'boolean') {
        return `1:${value ? '1' : '0'}`;
    }

    if (typeof value === 'number') {
        return encodeNumber(value);
    }

    if (typeof value === 'string') {
        if (value.length > 1024) {
            throw new Error(`Index string value exceeds maximum length of 1024 characters`);
        }
        return `3:${value}`;
    }

    if (value instanceof Date) {
        return encodeDate(value);
    }

    // Fallback: JSON stringify for complex types
    return `3:${JSON.stringify(value)}`;
}

/**
 * Encode a number in sort-order-preserving format.
 * Uses a sign prefix and fixed-width hex encoding for consistent ordering.
 * Negative numbers are complemented so they sort correctly.
 */
export function encodeNumber(n: number): string {
    if (Number.isNaN(n)) return '2:N';
    if (n === Infinity) return '2:Z';
    if (n === -Infinity) return '2:A';

    // Use fixed-width encoding with sign handling
    // Positive: 2:P:{16-char hex}, Negative: 2:N:{complemented 16-char hex}
    const buf = Buffer.alloc(8);
    buf.writeDoubleBE(n, 0);

    // IEEE 754 doubles: flip sign bit for positive, flip all bits for negative
    // This gives correct lexicographic ordering
    const high = buf.readUInt32BE(0);
    const low = buf.readUInt32BE(4);

    if (n >= 0) {
        // Positive or +0: flip sign bit (set bit 31 of high)
        const h = (high | 0x80000000) >>> 0;
        return `2:${h.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
    } else {
        // Negative: flip all bits
        const h = (~high) >>> 0;
        const l = (~low) >>> 0;
        return `2:${h.toString(16).padStart(8, '0')}${l.toString(16).padStart(8, '0')}`;
    }
}

/**
 * Encode a Date as 64-bit epoch milliseconds in big-endian hex.
 */
export function encodeDate(d: Date): string {
    const ms = d.getTime();
    // Convert to unsigned 64-bit representation
    const high = Math.floor(ms / 0x100000000) >>> 0;
    const low = (ms & 0xFFFFFFFF) >>> 0;
    return `4:${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}

/**
 * Compute the index scan range for a comparison operator.
 */
export function computeIndexRange(
    collection: string,
    field: string,
    operator: { $gt?: unknown; $gte?: unknown; $lt?: unknown; $lte?: unknown; $eq?: unknown }
): { startKey: string; endKey: string } {
    const prefix = idxPrefix(collection, field);

    if (operator.$eq !== undefined) {
        const enc = encodeValue(operator.$eq);
        return {
            startKey: `${prefix}${enc}${IDX_ID_SEP}`,
            endKey: `${prefix}${enc}${IDX_ID_SEP}\xff`,
        };
    }

    let startKey = prefix;
    let endKey = `${prefix}\xff`;

    if (operator.$gt !== undefined) {
        startKey = `${prefix}${encodeValue(operator.$gt)}${IDX_ID_SEP}\xff`;
    } else if (operator.$gte !== undefined) {
        startKey = `${prefix}${encodeValue(operator.$gte)}${IDX_ID_SEP}`;
    }

    if (operator.$lt !== undefined) {
        endKey = `${prefix}${encodeValue(operator.$lt)}${IDX_ID_SEP}`;
    } else if (operator.$lte !== undefined) {
        endKey = `${prefix}${encodeValue(operator.$lte)}${IDX_ID_SEP}\xff`;
    }

    return { startKey, endKey };
}
