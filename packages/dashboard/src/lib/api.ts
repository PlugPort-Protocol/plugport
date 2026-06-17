'use client';

import { useState, useEffect, useCallback } from 'react';

// ---- Dynamic API Base + Auth Token ----
// These are module-level state variables that can be updated at runtime.
// The server URL and auth token are persisted in localStorage by AuthProvider.

let _serverUrl: string | null = null;
let _authToken: string | null = null;

/** Set the PlugPort server URL at runtime (e.g., from settings or AuthProvider) */
export function setServerUrl(url: string | null): void {
    _serverUrl = url;
}

/** Set the JWT auth token at runtime (called after SIWE verification) */
export function setAuthToken(jwt: string | null): void {
    _authToken = jwt;
}

/** Get current API base URL */
function getApiBase(): string {
    if (_serverUrl) return _serverUrl;
    return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
}

/** Build auth headers based on current auth state */
function getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};

    // Priority: JWT token (wallet auth) > legacy API key
    if (_authToken) {
        headers['Authorization'] = `Bearer ${_authToken}`;
    } else if (process.env.NEXT_PUBLIC_TDBX_API_KEY) {
        headers['x-api-key'] = process.env.NEXT_PUBLIC_TDBX_API_KEY;
    }

    return headers;
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
                headers: getAuthHeaders(),
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
        const res = await fetch(`${getApiBase()}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...getAuthHeaders(),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const json = await res.json();
        if (!res.ok) {
            throw new Error((json as Record<string, string>).errmsg || `HTTP ${res.status}`);
        }
        return json as T;
    } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') throw new Error('Request timed out after 10s');
        throw err;
    }
}

export async function apiGet<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch(`${getApiBase()}${path}`, {
            signal: controller.signal,
            headers: getAuthHeaders(),
        });
        clearTimeout(timeoutId);
        const json = await res.json();
        if (!res.ok) {
            throw new Error((json as Record<string, string>).errmsg || `HTTP ${res.status}`);
        }
        return json as T;
    } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') throw new Error('Request timed out after 10s');
        throw err;
    }
}

export async function apiDelete<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch(`${getApiBase()}${path}`, {
            method: 'DELETE',
            headers: getAuthHeaders(),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const json = await res.json();
        if (!res.ok) {
            throw new Error((json as Record<string, string>).errmsg || `HTTP ${res.status}`);
        }
        return json as T;
    } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') throw new Error('Request timed out after 10s');
        throw err;
    }
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch(`${getApiBase()}${path}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                ...getAuthHeaders(),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const json = await res.json();
        if (!res.ok) {
            throw new Error((json as Record<string, string>).errmsg || `HTTP ${res.status}`);
        }
        return json as T;
    } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') throw new Error('Request timed out after 10s');
        throw err;
    }
}
