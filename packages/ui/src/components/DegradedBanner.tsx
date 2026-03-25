import * as React from "react";
import { X } from "lucide-react";
import { createHealthPoller, shouldTriggerRecoveryPoll, type RelayStatus } from "./DegradedBanner.logic";

/**
 * Dismissable amber banner shown when the server's /health endpoint reports
 * degraded state (Redis or Socket.IO unavailable). Auto-retries every 30s
 * and hides itself if the server recovers.
 */
export function DegradedBanner({ relayStatus }: { relayStatus?: RelayStatus }) {
    const [degraded, setDegraded] = React.useState(false);
    const [dismissed, setDismissed] = React.useState(false);
    const pollRef = React.useRef<(() => Promise<void>) | null>(null);
    const prevRelayStatusRef = React.useRef<RelayStatus | null>(null);

    // Poll on mount and every 30s afterwards using a single shared poller so
    // the in-flight guard covers both the immediate call and each interval tick.
    // A separate poller per effect would allow the mount call and the first
    // interval tick to overlap, defeating the "no stacking" guarantee.
    React.useEffect(() => {
        const controller = new AbortController();
        const poll = createHealthPoller(setDegraded, controller.signal);
        pollRef.current = poll;
        // Immediate check on mount.
        void poll();
        // Periodic re-check; skipped automatically if a fetch is still in flight.
        const id = setInterval(() => {
            void poll();
        }, 30_000);
        return () => {
            pollRef.current = null;
            clearInterval(id);
            controller.abort();
        };
    }, []);

    // When the server recovers, lift the dismiss so the banner disappears.
    React.useEffect(() => {
        if (!degraded) setDismissed(false);
    }, [degraded]);

    // If relay connectivity comes back, trigger an immediate health check so
    // the banner clears right away instead of waiting for the 30s interval.
    React.useEffect(() => {
        if (!relayStatus) return;
        const previous = prevRelayStatusRef.current;
        prevRelayStatusRef.current = relayStatus;
        if (shouldTriggerRecoveryPoll(previous, relayStatus)) {
            void pollRef.current?.();
        }
    }, [relayStatus]);

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
