/**
 * Pure logic for DegradedBanner — extracted here so it can be unit-tested
 * without a DOM environment or React Testing Library.
 */

export interface HealthResponse {
    status: "ok" | "degraded";
    redis: boolean;
    socketio: boolean;
    uptime: number;
}

export type RelayStatus = "connecting" | "connected" | "disconnected";

/**
 * Trigger an immediate health repoll only when relay connectivity transitions
 * from a non-connected state into connected.
 */
export function shouldTriggerRecoveryPoll(
    previous: RelayStatus | null,
    next: RelayStatus,
): boolean {
    return previous !== "connected" && next === "connected";
}

/**
 * Determine from a parsed /health response whether the server is degraded.
 * The `status` field is authoritative.
 */
export function parseHealthDegraded(data: HealthResponse): boolean {
    return data.status === "degraded";
}

/**
 * Fetch /health and return whether the server is in a degraded state.
 *
 * - Returns `false` when the server responds with `status: "ok"`.
 * - Returns `true` when the server responds with `status: "degraded"`.
 * - Returns `true` on any network/parse failure (treat outage as degraded).
 * - Re-throws `AbortError` so callers can detect intentional cancellation.
 */
export async function fetchHealthDegraded(signal?: AbortSignal): Promise<boolean> {
    try {
        const res = await fetch("/health", { signal });
        const raw: unknown = await res.json();
        // Validate the schema before trusting it.  If the response is missing
        // the `status` field or carries an unknown value, treat the server as
        // degraded (fail-safe) rather than silently returning false.
        if (
            typeof raw !== "object" ||
            raw === null ||
            !("status" in raw) ||
            ((raw as Record<string, unknown>).status !== "ok" &&
                (raw as Record<string, unknown>).status !== "degraded")
        ) {
            return true;
        }
        return parseHealthDegraded(raw as HealthResponse);
    } catch (err) {
        // Let intentional cancellations propagate so callers can ignore them.
        if (err instanceof Error && err.name === "AbortError") throw err;
        // Any other error (network down, JSON parse failure) → treat as degraded.
        return true;
    }
}

/**
 * Create a health-check poll function with an **in-flight guard**.
 *
 * Calls to the returned `poll()` function are no-ops while a previous call
 * is still awaiting a response.  This prevents stacking concurrent fetches
 * when a slow network causes a tick to overlap with the next interval fire.
 *
 * @param onResult  Callback invoked with the degraded flag after each completed poll.
 * @param signal    Optional AbortSignal to cancel any in-flight fetch.
 */
export function createHealthPoller(
    onResult: (degraded: boolean) => void,
    signal?: AbortSignal,
): () => Promise<void> {
    let inFlight = false;

    return async function poll(): Promise<void> {
        if (inFlight) return;
        inFlight = true;
        try {
            const degraded = await fetchHealthDegraded(signal);
            onResult(degraded);
        } catch (err) {
            // AbortError means the poller was torn down (component unmounted);
            // silently discard so we don't trigger a state update on an
            // unmounted component.
            if (err instanceof Error && err.name === "AbortError") return;
            onResult(true);
        } finally {
            inFlight = false;
        }
    };
}
