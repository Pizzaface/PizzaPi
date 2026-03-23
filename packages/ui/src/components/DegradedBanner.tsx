import * as React from "react";
import { X } from "lucide-react";

interface HealthResponse {
    status: "ok" | "degraded";
    redis: boolean;
    socketio: boolean;
    uptime: number;
}

/**
 * Dismissable amber banner shown when the server's /health endpoint reports
 * degraded state (Redis or Socket.IO unavailable). Auto-retries every 30s
 * and hides itself if the server recovers.
 */
export function DegradedBanner() {
    const [degraded, setDegraded] = React.useState(false);
    const [dismissed, setDismissed] = React.useState(false);

    const checkHealth = React.useCallback(async (signal?: AbortSignal) => {
        try {
            const res = await fetch("/health", { signal });
            const data: HealthResponse = await res.json();
            setDegraded(data.status === "degraded");
        } catch (err) {
            // Ignore intentional cancellations (component unmounted mid-fetch)
            if (err instanceof Error && err.name === "AbortError") return;
            // Network failure — treat as degraded
            setDegraded(true);
        }
    }, []);

    // Check on mount; cancel the in-flight fetch if the component unmounts.
    React.useEffect(() => {
        const controller = new AbortController();
        void checkHealth(controller.signal);
        return () => controller.abort();
    }, [checkHealth]);

    // When the server recovers, lift the dismiss so the banner disappears.
    React.useEffect(() => {
        if (!degraded) setDismissed(false);
    }, [degraded]);

    // Auto-retry every 30s, reusing checkHealth to avoid logic duplication.
    // Cancel any in-flight fetch when the interval is torn down on unmount.
    React.useEffect(() => {
        const controller = new AbortController();
        const id = setInterval(() => {
            void checkHealth(controller.signal);
        }, 30_000);
        return () => {
            clearInterval(id);
            controller.abort();
        };
    }, [checkHealth]);

    if (!degraded || dismissed) return null;

    return (
        <div
            role="alert"
            className="flex items-center justify-between gap-3 px-4 py-2 text-sm bg-amber-500/10 text-amber-600 dark:text-amber-400 border-b border-amber-500/20"
        >
            <span>
                <span aria-hidden="true">⚠️</span>{" "}
                Server running in degraded mode — real-time updates unavailable
            </span>
            <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setDismissed(true)}
                className="shrink-0 rounded p-0.5 hover:bg-amber-500/20 transition-colors"
            >
                <X className="size-4" />
            </button>
        </div>
    );
}
