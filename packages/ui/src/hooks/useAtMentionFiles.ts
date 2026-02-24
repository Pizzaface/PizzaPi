import { useState, useEffect, useRef, useCallback } from "react";

/**
 * File/directory entry returned by the files API
 */
export interface Entry {
    name: string;
    path: string;
    isDirectory: boolean;
    isSymlink: boolean;
    size?: number;
}

interface FilesResponse {
    ok: boolean;
    files?: Entry[];
    error?: string;
    message?: string;
}

interface UseAtMentionFilesResult {
    entries: Entry[];
    loading: boolean;
    error: string | null;
}

/**
 * Hook to fetch directory listings for @-mention file autocomplete.
 * Provides per-session path-keyed caching and ~100ms debounce.
 *
 * @param runnerId - Runner ID to fetch files from
 * @param path - Directory path to list
 * @param enabled - Whether fetching is enabled (cache clears on true → false)
 */
export function useAtMentionFiles(
    runnerId: string | undefined,
    path: string,
    enabled: boolean
): UseAtMentionFilesResult {
    const [entries, setEntries] = useState<Entry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Path-keyed cache scoped to this hook instance
    const cacheRef = useRef<Map<string, Entry[]>>(new Map());

    // Track previous enabled state to detect true → false transitions
    const prevEnabledRef = useRef<boolean>(enabled);

    // Debounce timer ref
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Abort controller for in-flight requests
    const abortControllerRef = useRef<AbortController | null>(null);

    // Clear cache when enabled flips from true to false
    useEffect(() => {
        if (prevEnabledRef.current && !enabled) {
            cacheRef.current.clear();
        }
        prevEnabledRef.current = enabled;
    }, [enabled]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
        };
    }, []);

    const fetchFiles = useCallback(
        async (targetPath: string, signal: AbortSignal) => {
            if (!runnerId) return;

            setLoading(true);
            setError(null);

            try {
                const response = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/files`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: targetPath }),
                    credentials: "include",
                    signal,
                });

                if (signal.aborted) return;

                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.error || `HTTP ${response.status}`);
                }

                const data: FilesResponse = await response.json();

                if (signal.aborted) return;

                if (!data.ok) {
                    throw new Error(data.message || data.error || "Failed to list files");
                }

                const files = data.files ?? [];
                cacheRef.current.set(targetPath, files);
                setEntries(files);
                setError(null);
            } catch (err) {
                if (signal.aborted) return;
                const message = err instanceof Error ? err.message : String(err);
                // Don't set error for abort
                if (message !== "AbortError" && !message.includes("aborted")) {
                    setError(message);
                    setEntries([]);
                }
            } finally {
                if (!signal.aborted) {
                    setLoading(false);
                }
            }
        },
        [runnerId]
    );

    // Main effect: debounced fetch with caching
    useEffect(() => {
        // Guard: return empty immediately if disabled or no runnerId
        if (!enabled || !runnerId) {
            setEntries([]);
            setLoading(false);
            setError(null);
            return;
        }

        // Check cache first
        const cached = cacheRef.current.get(path);
        if (cached) {
            setEntries(cached);
            setLoading(false);
            setError(null);
            return;
        }

        // Cancel any pending debounce timer
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }

        // Cancel any in-flight request
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }

        // Set loading immediately for UX feedback
        setLoading(true);

        // Debounce the fetch by ~100ms
        debounceTimerRef.current = setTimeout(() => {
            const controller = new AbortController();
            abortControllerRef.current = controller;
            fetchFiles(path, controller.signal);
        }, 100);

        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
        };
    }, [runnerId, path, enabled, fetchFiles]);

    return { entries, loading, error };
}
