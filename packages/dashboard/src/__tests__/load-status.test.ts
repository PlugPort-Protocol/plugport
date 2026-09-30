// While the server was down or rate-limited, the Overview showed "0 collections"
// because load errors were swallowed. The data on screen must say when it did not
// come from the server — and a proxy's HTML error page must not hide the reason.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { NOT_LOADED, loadSucceeded, loadFailed, loadErrorBanner, describeLoadError } from '../lib/load-status';
import { apiGet, ApiError } from '../lib/api';

afterEach(() => vi.unstubAllGlobals());

describe('load status', () => {
    it('before any successful load, a failure says nothing current is shown', () => {
        const status = loadFailed(NOT_LOADED, new TypeError('Failed to fetch'));
        expect(status.loaded).toBe(false);
        expect(loadErrorBanner('collections', status)).toBe(
            "Couldn't load collections: the server could not be reached. Nothing shown here is current.",
        );
    });

    it('after a successful load, a failed refresh keeps the data and says how old it is', () => {
        const ok = loadSucceeded(Date.UTC(2026, 8, 30, 12, 4, 31));
        const status = loadFailed(ok, new ApiError('HTTP 502', 502));
        expect(status).toMatchObject({ loaded: true, updatedAt: ok.updatedAt });
        expect(loadErrorBanner('collections', status)).toMatch(/^Couldn't refresh collections: the server is unavailable \(HTTP 502\)\. Showing data from .+\.$/);
    });

    it('a successful load clears the error', () => {
        expect(loadErrorBanner('collections', loadSucceeded())).toBeNull();
    });

    it('names the common failure modes', () => {
        expect(describeLoadError(new Error('Request timed out after 10s'))).toBe('the server did not answer in time');
        expect(describeLoadError(new ApiError('Authentication required', 401))).toMatch(/not signed in/);
        expect(describeLoadError(new ApiError('Too many requests', 429))).toMatch(/rate-limiting/);
        expect(describeLoadError(new ApiError('boom', 500))).toBe('the server returned an error (HTTP 500)');
        expect(describeLoadError(new ApiError('collection not found', 404))).toBe('collection not found');
    });
});

describe('apiGet errors', () => {
    it('reports the HTTP status of a proxy error page instead of a JSON parse error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })));
        const err = await apiGet('/api/v1/collections').catch((e) => e);
        expect(err).toBeInstanceOf(ApiError);
        expect(err.status).toBe(502);
        expect(describeLoadError(err)).toBe('the server is unavailable (HTTP 502)');
    });

    it("keeps the server's own error message", async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: 0, errmsg: 'Authentication required' }, { status: 401 })));
        const err = await apiGet('/api/v1/keys').catch((e) => e);
        expect(err.message).toBe('Authentication required');
        expect(err.status).toBe(401);
    });

    it('rejects a successful response that is not JSON', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>maintenance</html>', { status: 200 })));
        await expect(apiGet('/api/v1/collections')).rejects.toThrow(/not JSON/);
    });
});
