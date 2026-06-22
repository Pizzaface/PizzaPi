import { useState, useCallback } from "react";

interface UseServiceToggleOptions {
    runnerId: string;
    serviceId: string;
    initialValue: boolean;
}

interface UseServiceToggleReturn {
    enabled: boolean;
    loading: boolean;
    error: string | null;
    toggle: () => Promise<void>;
    refresh: () => Promise<void>;
}

/**
 * Hook to toggle a runner service's enabled state via the REST API.
 */
export function useServiceToggle({ runnerId, serviceId, initialValue }: UseServiceToggleOptions): UseServiceToggleReturn {
    const [enabled, setEnabled] = useState(initialValue);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/services/${encodeURIComponent(serviceId)}/enabled`, {
                credentials: "include",
            });
            if (!res.ok) {
                throw new Error(`Failed to fetch service state: ${res.status}`);
            }
            const state = await res.json();
            setEnabled(state.enabled);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to fetch service state");
        } finally {
            setLoading(false);
        }
    }, [runnerId, serviceId]);

    const toggle = useCallback(async () => {
        const previousState = enabled;
        const nextState = !previousState;
        
        // Optimistic update
        setEnabled(nextState);
        setLoading(true);
        setError(null);

        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/services/${encodeURIComponent(serviceId)}/enabled`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ enabled: nextState }),
            });

            if (!res.ok) {
                const errorData = await res.json().catch(() => ({ error: "Failed to toggle service" }));
                throw new Error(errorData.error || `HTTP ${res.status}`);
            }

            const result = await res.json();
            setEnabled(result.enabled);
        } catch (err) {
            // Revert on error
            setEnabled(previousState);
            setError(err instanceof Error ? err.message : "Failed to toggle service");
        } finally {
            setLoading(false);
        }
    }, [runnerId, serviceId, enabled]);

    return { enabled, loading, error, toggle, refresh };
}
