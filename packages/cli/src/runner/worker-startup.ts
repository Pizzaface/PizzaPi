/**
 * Worker startup handshake (daemon ⇄ session worker IPC).
 *
 * The daemon used to report `session_ready` to the relay as soon as it had
 * spawned a worker process. A worker that then refused to start — most
 * importantly because an explicitly requested sandbox could not be enabled
 * (fail-closed) — exited moments later with the reason only on stderr, while
 * the relay and UI had already been told the session was ready.
 *
 * Now the worker reports the outcome of its security-critical startup phase
 * over the IPC channel:
 *   - `{ type: "startup_ready" }` once the whole boot chain has completed
 *     (sandbox, project trust, resource/plugin loading, model runtime,
 *     session creation and extension binding);
 *   - `{ type: "startup_error", message }` when startup fails before that.
 * The daemon waits for one of those (or for the worker to exit) before it
 * emits `session_ready` / `session_error`. The wait is bounded: if neither
 * arrives within {@link WORKER_STARTUP_TIMEOUT_MS} the worker is still
 * running, so the daemon falls back to the previous optimistic
 * `session_ready` and logs a warning. Fail-closed enforcement itself never
 * depends on this handshake — the worker exits before any tool can run.
 */
import type { ChildProcess } from "node:child_process";

export const WORKER_STARTUP_READY = "startup_ready";
export const WORKER_STARTUP_ERROR = "startup_error";

/** Upper bound the daemon waits for a worker's startup report. */
export const WORKER_STARTUP_TIMEOUT_MS = 20_000;

/** Longest startup error message forwarded to the relay. */
const MAX_STARTUP_ERROR_LENGTH = 2000;

export type WorkerStartupResult =
    | { ok: true; timedOut?: boolean }
    | { ok: false; message: string };

function truncate(message: string): string {
    return message.length > MAX_STARTUP_ERROR_LENGTH
        ? `${message.slice(0, MAX_STARTUP_ERROR_LENGTH)}…`
        : message;
}

// ── Worker side ──────────────────────────────────────────────────────────────

let startupReported = false;

/** Worker: report that the full startup chain (including the sandbox stage) succeeded. */
export function reportWorkerStartupReady(): void {
    if (startupReported) return;
    startupReported = true;
    if (typeof process.send !== "function") return;
    try {
        process.send({ type: WORKER_STARTUP_READY });
    } catch {
        // IPC already closed — the daemon will see the exit instead.
    }
}

/**
 * Worker: report a startup failure and resolve once the message has been
 * flushed (or after a short bound), so the caller can exit afterwards
 * without losing it. No-op once readiness was already reported.
 */
export function reportWorkerStartupError(err: unknown): Promise<void> {
    if (startupReported) return Promise.resolve();
    startupReported = true;
    const send = process.send;
    if (typeof send !== "function") return Promise.resolve();
    const message = truncate(err instanceof Error ? err.message : String(err));
    return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        try {
            // Node/Bun accept send(message, callback); the callback fires once
            // the message has been handed to the IPC channel.
            const sendWithCallback = send as unknown as (msg: unknown, cb: (err: Error | null) => void) => boolean;
            sendWithCallback.call(process, { type: WORKER_STARTUP_ERROR, message }, () => {
                clearTimeout(timer);
                resolve();
            });
        } catch {
            clearTimeout(timer);
            resolve();
        }
    });
}

// ── Daemon side ──────────────────────────────────────────────────────────────

/**
 * Daemon: wait (bounded) for a spawned worker's startup report and call
 * `onResult` exactly once. An exit before any report is a startup failure,
 * except a restart-in-place (exit code 43), whose replacement worker reports
 * for itself — in that case `onResult` is not called.
 */
export function watchWorkerStartup(
    child: Pick<ChildProcess, "on" | "off">,
    onResult: (result: WorkerStartupResult) => void,
    options?: { timeoutMs?: number; onTimeout?: () => void },
): void {
    let settled = false;
    const finish = (result: WorkerStartupResult | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        if (result) onResult(result);
    };
    const onMessage = (msg: unknown) => {
        if (typeof msg !== "object" || msg === null) return;
        const message = msg as Record<string, unknown>;
        if (message.type === WORKER_STARTUP_READY) {
            finish({ ok: true });
        } else if (message.type === WORKER_STARTUP_ERROR) {
            const text = typeof message.message === "string" && message.message.trim()
                ? message.message
                : "Session worker failed to start";
            finish({ ok: false, message: truncate(text) });
        }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (code === 43) {
            finish(null);
            return;
        }
        finish({
            ok: false,
            message: `Session worker exited during startup (code=${code}, signal=${signal})`,
        });
    };
    const timer = setTimeout(() => {
        options?.onTimeout?.();
        finish({ ok: true, timedOut: true });
    }, options?.timeoutMs ?? WORKER_STARTUP_TIMEOUT_MS);
    child.on("message", onMessage);
    child.on("exit", onExit);
}
