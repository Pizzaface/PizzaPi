/**
 * Cross-platform child-process shutdown helpers.
 *
 * Windows has no deliverable signals: `child.kill("SIGTERM")` is an immediate
 * TerminateProcess, so the target's `process.on("SIGTERM")` cleanup never runs
 * and its own children (MCP servers, shells) are orphaned. Graceful shutdown
 * on Windows therefore goes over the IPC channel, and hard kills go through
 * `taskkill /T` so the whole process tree dies together.
 */

import { execFile, type ChildProcess } from "node:child_process";

export const STOP_FILE_NAME = "runner.stop";

/** IPC message understood by daemon and workers as a graceful-shutdown request. */
export const SHUTDOWN_MESSAGE = { type: "shutdown" } as const;

export function isShutdownMessage(msg: unknown): boolean {
    return typeof msg === "object" && msg !== null && (msg as Record<string, unknown>).type === "shutdown";
}

/**
 * Hard-kill a child and, on Windows, its entire process tree.
 * `taskkill /T` reaches grandchildren that a plain kill() would orphan —
 * Windows has no process groups to signal.
 */
export function forceKillTree(child: ChildProcess): void {
    if (process.platform === "win32" && typeof child.pid === "number" && child.pid > 0) {
        try {
            execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {
                // taskkill missing or failed — fall back to a plain kill.
                try {
                    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
                } catch {}
            });
            return;
        } catch {
            // fall through to plain kill
        }
    }
    try {
        child.kill("SIGKILL");
    } catch {}
}

/**
 * Ask a child to shut down gracefully, then hard-kill (tree kill on Windows)
 * if it hasn't exited after `timeoutMs`.
 *
 * - POSIX: SIGTERM → catchable, child runs its shutdown handler.
 * - Windows with an IPC channel: `{ type: "shutdown" }` message — the only
 *   catchable cross-process shutdown request that exists there.
 * - Windows without IPC: immediate hard kill (nothing gentler is possible).
 */
export function requestChildShutdown(
    child: ChildProcess,
    onEscalate?: (timeoutMs: number) => void,
    timeoutMs = 5_000,
): void {
    let requested = false;
    if (process.platform === "win32") {
        if (child.connected && typeof child.send === "function") {
            try {
                child.send(SHUTDOWN_MESSAGE);
                requested = true;
            } catch {
                // channel already closed — fall through
            }
        }
    } else {
        try {
            child.kill("SIGTERM");
            requested = true;
        } catch {}
    }

    if (!requested) {
        forceKillTree(child);
        return;
    }

    const timer = setTimeout(() => {
        try {
            if (child.exitCode === null && !child.killed) {
                onEscalate?.(timeoutMs);
                forceKillTree(child);
            }
        } catch {}
    }, timeoutMs);
    child.once("exit", () => clearTimeout(timer));
}
