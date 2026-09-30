// Tracks whether data shown on screen actually came from the server.
//
// The dashboard used to swallow load errors (`catch { /* ignore */ }`), so while
// the server was down or rate-limited the Overview showed "0 collections" and
// "No collections yet" — indistinguishable from an empty database. The rule now,
// as for API keys (commit 5e87e4a): show "empty" only after a load succeeded;
// on a failed refresh keep the last data and say it is stale; before any
// successful load, show the error instead of zeros.

export interface LoadStatus {
    /** At least one load has succeeded, so the data on screen is real. */
    loaded: boolean;
    /** The last attempt's error, or null if it succeeded. */
    error: string | null;
    /** When the data on screen was fetched (ms since epoch). */
    updatedAt: number | null;
}

export const NOT_LOADED: LoadStatus = { loaded: false, error: null, updatedAt: null };

export function loadSucceeded(now = Date.now()): LoadStatus {
    return { loaded: true, error: null, updatedAt: now };
}

/** Keeps `loaded` and `updatedAt` from the previous status: the old data is still on screen. */
export function loadFailed(prev: LoadStatus, err: unknown): LoadStatus {
    return { ...prev, error: describeLoadError(err) };
}

/** A short, human reason for a failed request. */
export function describeLoadError(err: unknown): string {
    const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 0;
    if (/timed out/i.test(message)) return 'the server did not answer in time';
    // fetch() rejects with a TypeError ("Failed to fetch" / "Load failed" / "NetworkError…") when nothing answers.
    if (/failed to fetch|networkerror|load failed/i.test(message)) return 'the server could not be reached';
    if (status === 401 || status === 403) return 'the server refused the request (not signed in?)';
    if (status === 429) return 'the server is rate-limiting requests';
    if (status === 502 || status === 503 || status === 504) return `the server is unavailable (HTTP ${status})`;
    if (status >= 500) return `the server returned an error (HTTP ${status})`;
    return message || 'the request failed';
}

/** "12:04:31" in the viewer's locale. */
export function formatClock(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Banner text for a failed load of `what`, or null when there is nothing to
 * say. Distinguishes stale data (still shown) from no data at all.
 */
export function loadErrorBanner(what: string, status: LoadStatus): string | null {
    if (!status.error) return null;
    if (status.loaded && status.updatedAt !== null) {
        return `Couldn't refresh ${what}: ${status.error}. Showing data from ${formatClock(status.updatedAt)}.`;
    }
    return `Couldn't load ${what}: ${status.error}. Nothing shown here is current.`;
}
