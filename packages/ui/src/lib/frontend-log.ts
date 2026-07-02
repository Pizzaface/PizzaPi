/**
 * Frontend error log + toast bus.
 *
 * A tiny, dependency-free store so any component can (1) surface an error as a
 * toast, (2) append it to an in-app, viewable log for troubleshooting, and
 * (3) have it echoed to the console. Also captures uncaught errors and
 * unhandled promise rejections globally.
 *
 * ponytail: module-level ring buffer + Set of listeners; no store lib. Swap for
 * a real store only if the log needs cross-tab persistence.
 */

export type LogLevel = "info" | "warning" | "error";

export interface FrontendLogEntry {
    id: string;
    ts: number;
    scope: string;
    level: LogLevel;
    message: string;
    /** Optional extra context (stack, response body, url, …). */
    detail?: string;
}

const MAX_ENTRIES = 500;

let entries: FrontendLogEntry[] = [];
const logListeners = new Set<() => void>();
const toastListeners = new Set<(t: { message: string; type: LogLevel }) => void>();

function emitLogChange(): void {
    for (const l of logListeners) l();
}

function nextId(): string {
    return `fl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Append an entry to the log (and mirror to console). */
export function logFrontendEvent(
    scope: string,
    level: LogLevel,
    message: string,
    detail?: string,
): FrontendLogEntry {
    const entry: FrontendLogEntry = { id: nextId(), ts: Date.now(), scope, level, message, detail };
    // New array reference so useSyncExternalStore detects the change.
    entries = [...entries.slice(-(MAX_ENTRIES - 1)), entry];
    emitLogChange();
    const line = `[${scope}] ${message}${detail ? ` — ${detail}` : ""}`;
    if (level === "error") console.error(line);
    else if (level === "warning") console.warn(line);
    else console.info(line);
    return entry;
}

/**
 * Report an error: log it, and (by default) show a toast so the user sees it
 * immediately. Use `toast: false` for background/noisy errors that only need
 * to land in the log.
 */
export function reportError(
    scope: string,
    message: string,
    opts: { detail?: string; toast?: boolean } = {},
): void {
    logFrontendEvent(scope, "error", message, opts.detail);
    if (opts.toast !== false) showToast(message, "error");
}

export function reportWarning(scope: string, message: string, opts: { detail?: string; toast?: boolean } = {}): void {
    logFrontendEvent(scope, "warning", message, opts.detail);
    if (opts.toast) showToast(message, "warning");
}

/** Push a toast without necessarily logging (logging still recommended). */
export function showToast(message: string, type: LogLevel = "info"): void {
    for (const l of toastListeners) l({ message, type });
}

// ── React store subscriptions ────────────────────────────────────────────────

export function subscribeFrontendLog(cb: () => void): () => void {
    logListeners.add(cb);
    return () => logListeners.delete(cb);
}

export function getFrontendLog(): FrontendLogEntry[] {
    return entries;
}

export function clearFrontendLog(): void {
    entries = [];
    emitLogChange();
}

/** App.tsx bridges these into its existing toast UI. */
export function subscribeToast(cb: (t: { message: string; type: LogLevel }) => void): () => void {
    toastListeners.add(cb);
    return () => toastListeners.delete(cb);
}

// ── Global capture ────────────────────────────────────────────────────────────

let globalCaptureInstalled = false;

/** Capture uncaught errors + unhandled rejections into the log. Idempotent. */
export function installGlobalErrorCapture(): void {
    if (globalCaptureInstalled || typeof window === "undefined") return;
    globalCaptureInstalled = true;

    window.addEventListener("error", (e: ErrorEvent) => {
        // Resource-load errors (img/script) have no `error` and a target; skip those.
        if (!e.message && !e.error) return;
        logFrontendEvent(
            "window",
            "error",
            e.message || "Uncaught error",
            e.error instanceof Error ? e.error.stack : `${e.filename}:${e.lineno}:${e.colno}`,
        );
    });

    window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
        const reason = e.reason;
        const message = reason instanceof Error ? reason.message : String(reason);
        logFrontendEvent(
            "promise",
            "error",
            `Unhandled rejection: ${message}`,
            reason instanceof Error ? reason.stack : undefined,
        );
    });
}
