'use client';

import { useState, useEffect, useCallback } from 'react';

// ---- Dynamic API Base ----
// The server URL is persisted in localStorage by AuthProvider.

let _serverUrl: string | null = null;

/** Set the PlugPort server URL at runtime (e.g., from settings or AuthProvider) */
export function setServerUrl(url: string | null): void {
    _serverUrl = url;
}

/** Get current API base URL */
function getApiBase(): string {
    if (_serverUrl) return _serverUrl;
    return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
}

/**
 * Build common fetch options.
 * Includes credentials: 'include' so the httpOnly session cookie is sent automatically.
 * Falls back to legacy API key header if configured.
 */
function getCommonOptions(): RequestInit {
    const options: RequestInit = {
        credentials: 'include', // Send session cookie automatically
    };

    // Legacy API key support (non-cookie auth for CLI/SDK use)
    if (process.env.NEXT_PUBLIC_TDBX_API_KEY) {
        options.headers = {
            'x-api-key': process.env.NEXT_PUBLIC_TDBX_API_KEY,
        };
    }

    return options;
}

/**
 * Read the CSRF token from the non-httpOnly `plugport_csrf` cookie.
 * Returns undefined if not found (pre-auth or API key auth).
 */
function getCsrfToken(): string | undefined {
    if (typeof document === 'undefined') return undefined;
    const match = document.cookie.match(/(?:^|;\s*)plugport_csrf=([^;]*)/);
    return match?.[1];
}

// ---- React Hook ----

export function useApi<T>(path: string, options?: { autoFetch?: boolean }) {
    const [data, setData] = useState<T | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchData = useCallback(async () => {
        setLoading(true);
        setError(null);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s UI timeout
        try {
            const res = await fetch(`${getApiBase()}${path}`, {
                signal: controller.signal,
                ...getCommonOptions(),
            });
            clearTimeout(timeoutId);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            setData(json as T);
        } catch (err: any) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
                setError('Request timed out after 10s');
            } else {
                setError(err instanceof Error ? err.message : 'Request failed');
            }
        } finally {
            setLoading(false);
        }
    }, [path]);

    useEffect(() => {
        if (options?.autoFetch !== false) {
            fetchData();
        }
    }, [fetchData, options?.autoFetch]);

    return { data, loading, error, refetch: fetchData };
}

// ---- Direct API Calls ----

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
        const common = getCommonOptions();
        const csrfToken = getCsrfToken();
        const res = await fetch(`${getApiBase()}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(common.headers as Record<string, string> || {}),
                ...(csrfToken && !path.startsWith('/api/v1/auth/') ? { 'x-csrf-token': csrfToken } : {}),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
            credentials: 'include',
        });
        clearTimeout(timeoutId);
        const json = await res.json();
        if (!res.ok) {
            throw new Error((json as Record<string, string>).errmsg || `HTTP ${res.status}`);
        }
        return json as T;
    } catch (err: any) {
        clearTimeout(timeoutId);
        if (err?.name === 'AbortError') throw new Error('Request timed out after 10s', { cause: err });
        throw err;
    }
}

export async function apiGet<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch(`${getApiBase()}${path}`, {
            signal: controller.signal,
            ...getCommonOptions(),
        });
        clearTimeout(timeoutId);
        const json = await res.json();
        if (!res.ok) {
            throw new Error((json as Record<string, string>).errmsg || `HTTP ${res.status}`);
        }
        return json as T;
    } catch (err: any) {
        clearTimeout(timeoutId);
        if (err?.name === 'AbortError') throw new Error('Request timed out after 10s', { cause: err });
        throw err;
    }
}

export async function apiDelete<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
        const common = getCommonOptions();
        const csrfToken = getCsrfToken();
        const res = await fetch(`${getApiBase()}${path}`, {
            method: 'DELETE',
            headers: {
                ...(common.headers as Record<string, string> || {}),
                ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
            },
            signal: controller.signal,
            credentials: 'include',
        });
        clearTimeout(timeoutId);
        const json = await res.json();
        if (!res.ok) {
            throw new Error((json as Record<string, string>).errmsg || `HTTP ${res.status}`);
        }
        return json as T;
    } catch (err: any) {
        clearTimeout(timeoutId);
        if (err?.name === 'AbortError') throw new Error('Request timed out after 10s', { cause: err });
        throw err;
    }
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
        const common = getCommonOptions();
        const csrfToken = getCsrfToken();
        const res = await fetch(`${getApiBase()}${path}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                ...(common.headers as Record<string, string> || {}),
                ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
            credentials: 'include',
        });
        clearTimeout(timeoutId);
        const json = await res.json();
        if (!res.ok) {
            throw new Error((json as Record<string, string>).errmsg || `HTTP ${res.status}`);
        }
        return json as T;
    } catch (err: any) {
        clearTimeout(timeoutId);
        if (err?.name === 'AbortError') throw new Error('Request timed out after 10s', { cause: err });
        throw err;
    }
}
