import * as React from "react";
import { X } from "lucide-react";
import { createHealthPoller } from "./DegradedBanner.logic";

/**
 * Dismissable amber banner shown when the server's /health endpoint reports
 * degraded state (Redis or Socket.IO unavailable). Auto-retries every 30s
 * and hides itself if the server recovers.
 */
export function DegradedBanner() {
    const [degraded, setDegraded] = React.useState(false);
    const [dismissed, setDismissed] = React.useState(false);

    // Check on mount; cancel the in-flight fetch if the component unmounts.
    React.useEffect(() => {
        const controller = new AbortController();
        const poll = createHealthPoller(setDegraded, controller.signal);
        void poll();
        return () => controller.abort();
    }, []);

    // When the server recovers, lift the dismiss so the banner disappears.
    React.useEffect(() => {
        if (!degraded) setDismissed(false);
    }, [degraded]);

    // Auto-retry every 30s using a poller with an in-flight guard.
    // If a /health request stalls past 30s the next tick is skipped rather
    // than stacking an additional concurrent fetch.
    React.useEffect(() => {
        const controller = new AbortController();
        const poll = createHealthPoller(setDegraded, controller.signal);
        const id = setInterval(() => {
            void poll();
        }, 30_000);
        return () => {
            clearInterval(id);
            controller.abort();
        };
    }, []);

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
