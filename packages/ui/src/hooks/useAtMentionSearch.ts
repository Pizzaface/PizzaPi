import { useState, useEffect, useRef, useCallback } from "react";
import type { Entry } from "./useAtMentionFiles";

interface SearchFilesResponse {
    ok: boolean;
    files?: (Entry & { relativePath?: string })[];
    error?: string;
    message?: string;
}

interface UseAtMentionSearchResult {
    entries: (Entry & { relativePath?: string })[];
    loading: boolean;
    error: string | null;
}

/**
 * Hook for recursive file search (respects .gitignore).
 * Used when the user types a query after @ without a path separator.
 *
 * @param runnerId - Runner ID to search on
 * @param query - Search query (file name substring)
 * @param enabled - Whether searching is active
 * @param basePath - Absolute session CWD
 */
export function useAtMentionSearch(
    runnerId: string | undefined,
    query: string,
    enabled: boolean,
    basePath?: string,
): UseAtMentionSearchResult {
    const [entries, setEntries] = useState<(Entry & { relativePath?: string })[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
            if (abortControllerRef.current) abortControllerRef.current.abort();
        };
    }, []);

    // Clear when disabled
    useEffect(() => {
        if (!enabled) {
            setEntries([]);
            setLoading(false);
            setError(null);
        }
    }, [enabled]);

    const fetchResults = useCallback(
        async (searchQuery: string, signal: AbortSignal) => {
            if (!runnerId || !basePath) return;

            setLoading(true);
            setError(null);

            try {
                const response = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/search-files`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ cwd: basePath, query: searchQuery, limit: 50 }),
                    credentials: "include",
                    signal,
                });

                if (signal.aborted) return;

                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.error || `HTTP ${response.status}`);
                }

                const data: SearchFilesResponse = await response.json();
                if (signal.aborted) return;

                if (!data.ok) {
                    throw new Error(data.message || data.error || "Search failed");
                }

                setEntries(data.files ?? []);
                setError(null);
            } catch (err) {
                if (signal.aborted) return;
                const message = err instanceof Error ? err.message : String(err);
                if (!message.includes("aborted")) {
                    setError(message);
                    setEntries([]);
                }
            } finally {
                if (!signal.aborted) setLoading(false);
            }
        },
        [runnerId, basePath],
    );

    useEffect(() => {
        if (!enabled || !runnerId || !query) {
            setEntries([]);
            setLoading(false);
            setError(null);
            return;
        }

        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        if (abortControllerRef.current) abortControllerRef.current.abort();

        setLoading(true);

        // Slightly longer debounce for search (typing is ongoing)
        debounceTimerRef.current = setTimeout(() => {
            const controller = new AbortController();
            abortControllerRef.current = controller;
            fetchResults(query, controller.signal);
        }, 150);

        return () => {
            if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        };
    }, [runnerId, query, enabled, fetchResults]);

    return { entries, loading, error };
}
