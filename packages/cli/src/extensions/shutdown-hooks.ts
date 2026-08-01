/**
 * Worker pre-exit shutdown hooks.
 *
 * pi has no event for "flush something before the process exits". Its
 * `session_shutdown` is awaited, but only fires for in-app transitions
 * (`quit | reload | new | resume | fork`) — when the daemon SIGTERMs a worker,
 * the worker's own `process.on("SIGTERM")` handler is the only thing that runs.
 * That signal path is therefore the injection point, and it lives here rather
 * than inside any one feature's abstraction.
 *
 * These hooks MUST run in the worker process. Anything registered from a
 * session extension is a module-global of that worker, so a daemon-side import
 * of this module sees an empty registry (a cross-process call would be a
 * guaranteed no-op — see idea jg017xa4).
 */

import { createLogger } from "@pizzapi/tools";

const log = createLogger("shutdown-hooks");

/** Default overall budget, sized to stay inside the daemon's SIGTERM→SIGKILL escalation. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2500;

export type WorkerShutdownReason = "close" | "error" | "complete";

export interface WorkerShutdownContext {
    reason: WorkerShutdownReason;
    sessionId: string;
    sessionFile?: string;
    cwd: string;
    /**
     * Aborted when the overall deadline expires. Stopping the *wait* is not
     * enough — a hook that honours this can cancel its own in-flight work
     * instead of being cut off mid-write.
     */
    signal: AbortSignal;
    /** Absolute epoch-ms deadline shared by every hook in this shutdown. */
    deadline: number;
}

export type WorkerShutdownHook = (ctx: WorkerShutdownContext) => void | Promise<void>;

const hooks = new Map<string, WorkerShutdownHook>();

/**
 * Register an async cleanup to run once, in the worker, before exit.
 *
 * @returns an unregister function.
 */
export function registerWorkerShutdownHook(id: string, hook: WorkerShutdownHook): () => void {
    if (hooks.has(id)) {
        log.warn(`shutdown hook "${id}" was already registered — replacing it`);
    }
    hooks.set(id, hook);
    return () => {
        // Only remove our own registration; a later re-register under the same
        // id must not be dropped by a stale unregister closure.
        if (hooks.get(id) === hook) hooks.delete(id);
    };
}

export function registeredShutdownHookIds(): string[] {
    return [...hooks.keys()];
}

/**
 * Cached in-flight/completed run so concurrent shutdown paths (signal handler
 * and extension-initiated shutdownHandler) share ONE run instead of racing.
 * The second caller awaits the same promise rather than seeing a "done" flag
 * and proceeding to process.exit() while the first run is still writing.
 */
let inFlight: Promise<void> | null = null;

export async function runWorkerShutdownHooks(
    reason: WorkerShutdownReason,
    opts?: { timeoutMs?: number; sessionFile?: string; cwd?: string },
): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = doRunWorkerShutdownHooks(reason, opts);
    return inFlight;
}

async function doRunWorkerShutdownHooks(
    reason: WorkerShutdownReason,
    opts?: { timeoutMs?: number; sessionFile?: string; cwd?: string },
): Promise<void> {
    if (hooks.size === 0) return;

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const sessionId = process.env.PIZZAPI_SESSION_ID ?? process.env.SESSION_ID ?? "unknown";

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);

    const ctx: WorkerShutdownContext = {
        reason,
        sessionId,
        ...(opts?.sessionFile ? { sessionFile: opts.sessionFile } : {}),
        cwd: opts?.cwd ?? process.cwd(),
        signal: controller.signal,
        deadline,
    };

    // Hooks run concurrently and share ONE deadline, so N hooks are bounded by
    // timeoutMs rather than N * timeoutMs. Cleanups are independent by
    // contract; anything needing ordering should sequence itself inside one hook.
    const entries = [...hooks.entries()];
    const settled = Promise.allSettled(
        entries.map(async ([id, hook]) => {
            try {
                await hook(ctx);
            } catch (err) {
                // A failing cleanup must never block the others or the exit.
                log.error(`shutdown hook "${id}" failed:`, err);
            }
        }),
    );

    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            settled,
            new Promise<void>((resolve) => {
                budgetTimer = setTimeout(resolve, timeoutMs);
            }),
        ]);
        const overrun = entries.length && Date.now() >= deadline;
        if (overrun) {
            log.warn(`shutdown hooks exceeded ${timeoutMs}ms budget — continuing exit`);
        }
    } finally {
        clearTimeout(abortTimer);
        if (budgetTimer) clearTimeout(budgetTimer);
        controller.abort();
        // Never leave an unhandled rejection behind for hooks still running
        // past the deadline; we have already stopped waiting on them.
        void settled.catch(() => {});
    }
}

/** Test-only: clear the registry and any cached run. */
export function __resetWorkerShutdownHooksForTest(): void {
    hooks.clear();
    inFlight = null;
}
