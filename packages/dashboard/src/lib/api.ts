'use client';

import { useState, useEffect, useCallback } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

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
            const headers: Record<string, string> = {};
            if (process.env.NEXT_PUBLIC_TDBX_API_KEY) {
                headers['x-api-key'] = process.env.NEXT_PUBLIC_TDBX_API_KEY;
            }

            const res = await fetch(`${API_BASE}${path}`, {
                signal: controller.signal,
                headers
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

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (process.env.NEXT_PUBLIC_TDBX_API_KEY) {
            headers['x-api-key'] = process.env.NEXT_PUBLIC_TDBX_API_KEY;
        }

        const res = await fetch(`${API_BASE}${path}`, {
            method: 'POST',
            headers,
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
        const headers: Record<string, string> = {};
        if (process.env.NEXT_PUBLIC_TDBX_API_KEY) {
            headers['x-api-key'] = process.env.NEXT_PUBLIC_TDBX_API_KEY;
        }

        const res = await fetch(`${API_BASE}${path}`, {
            signal: controller.signal,
            headers
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
