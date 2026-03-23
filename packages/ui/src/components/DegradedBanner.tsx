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

    const checkHealth = React.useCallback(async () => {
        try {
            const res = await fetch("/health");
            const data: HealthResponse = await res.json();
            setDegraded(data.status === "degraded");
        } catch {
            // Network failure — treat as degraded
            setDegraded(true);
        }
    }, []);

    // Check on mount
    React.useEffect(() => {
        void checkHealth();
    }, [checkHealth]);

    // Auto-retry every 30s; if the server recovers, un-dismiss so the banner
    // can disappear naturally (we reset dismissed on recovery).
    React.useEffect(() => {
        const id = setInterval(async () => {
            try {
                const res = await fetch("/health");
                const data: HealthResponse = await res.json();
                const nowDegraded = data.status === "degraded";
                setDegraded(nowDegraded);
                // If it recovered, lift the dismiss so it disappears
                if (!nowDegraded) setDismissed(false);
            } catch {
                setDegraded(true);
            }
        }, 30_000);
        return () => clearInterval(id);
    }, []);

    if (!degraded || dismissed) return null;

    return (
        <div
            role="alert"
            className="flex items-center justify-between gap-3 px-4 py-2 text-sm bg-amber-500/10 text-amber-600 dark:text-amber-400 border-b border-amber-500/20"
        >
            <span>
                ⚠️ Server running in degraded mode — real-time updates unavailable
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
