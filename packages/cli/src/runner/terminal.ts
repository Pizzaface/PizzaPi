/**
 * Terminal PTY manager for the PizzaPi runner daemon.
 *
 * Each terminal is isolated in its own subprocess (terminal-worker.ts) so that
 * a crash in the PTY layer only kills the individual terminal worker process —
 * not the entire runner daemon.
 *
 * Message protocol (runner ↔ relay):
 *
 *   runner → relay:
 *     { type: "terminal_ready",  terminalId, runnerId }
 *     { type: "terminal_data",   terminalId, data }        // base64-encoded output
 *     { type: "terminal_exit",   terminalId, exitCode }
 *     { type: "terminal_error",  terminalId, message }
 *
 *   relay → runner:
 *     { type: "new_terminal",    terminalId, cwd?, cols?, rows?, shell? }
 *     { type: "terminal_input",  terminalId, data }        // base64-encoded input
 *     { type: "terminal_resize", terminalId, cols, rows }
 *     { type: "kill_terminal",   terminalId }
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { platform, arch } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface TerminalEntry {
    terminalId: string;
    worker: ChildProcess;
    startedAt: number;
}

const runningTerminals = new Map<string, TerminalEntry>();

/** Is this process running inside a compiled Bun single-file binary? */
// Detect compiled Bun single-file binary.
// - Unix: import.meta.url contains "$bunfs"
// - Windows: import.meta.url contains "~BUN" (drive letter/format varies)
const isCompiledBinary = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN");

/**
 * Resolve the path to the @zenyr/bun-pty native shared library.
 *
 * When running from a compiled binary, the build step places the .dylib/.so
 * next to the executable.  We return its path so we can set BUN_PTY_LIB for
 * the terminal worker subprocess (which also runs inside the compiled binary
 * and can't resolve node_modules paths).
 */
function resolvePtyLibPath(): string | undefined {
    // If already set by the user, respect it.
    if (process.env.BUN_PTY_LIB && existsSync(process.env.BUN_PTY_LIB)) {
        return process.env.BUN_PTY_LIB;
    }

    const os = platform();
    const cpu = arch();

    const libName =
        os === "darwin"
            ? cpu === "arm64" ? "librust_pty_arm64.dylib" : "librust_pty.dylib"
            : os === "win32"
                ? "rust_pty.dll"
                : cpu === "arm64" ? "librust_pty_arm64.so" : "librust_pty.so";

    if (isCompiledBinary) {
        // Compiled binary — library should be next to the executable.
        const exeDir = dirname(process.execPath);
        const candidate = join(exeDir, libName);
        if (existsSync(candidate)) return candidate;
    }

    // Also check node_modules for the platform-specific package (dev/npm installs).
    try {
        const platformPkg = `@zenyr/bun-pty-${os}-${cpu}`;
        const entryUrl = import.meta.resolve(platformPkg);
        const pkgDir = dirname(fileURLToPath(entryUrl));
        const candidate = join(pkgDir, libName);
        if (existsSync(candidate)) return candidate;
    } catch {}

    return undefined;
}

/** Cached PTY library path (resolved once at startup). */
const ptyLibPath = resolvePtyLibPath();

/** Resolve the terminal-worker spawn args (works for .ts, .js, and compiled binaries). */
function resolveWorkerSpawnArgs(): string[] {
    if (isCompiledBinary) {
        return ["_terminal-worker"];
    }
    const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const url = new URL(`./terminal-worker.${ext}`, import.meta.url);
    const path = fileURLToPath(url);
    if (existsSync(path)) return [path];
    // Fallback: try the other extension
    const altExt = ext === "ts" ? "js" : "ts";
    const alt = fileURLToPath(new URL(`./terminal-worker.${altExt}`, import.meta.url));
    if (existsSync(alt)) return [alt];
    throw new Error(`terminal-worker entry point not found: ${path}`);
}

/**
 * Spawn a new PTY terminal in an isolated worker process and wire its I/O to
 * a sender function.
 *
 * @param terminalId Unique identifier for this terminal session
 * @param send       Function to send messages back to the relay server
 * @param opts       Terminal options (cwd, shell, initial size)
 */
export function spawnTerminal(
    terminalId: string,
    send: (msg: Record<string, unknown>) => void,
    opts: {
        cwd?: string;
        shell?: string;
        cols?: number;
        rows?: number;
    } = {},
): void {
    if (runningTerminals.has(terminalId)) {
        send({ type: "terminal_error", terminalId, message: "Terminal already exists" });
        return;
    }

    const shell =
        opts.shell ||
        process.env.SHELL ||
        (platform() === "win32" ? "powershell.exe" : "/bin/bash");

    const cols = opts.cols && opts.cols > 0 ? opts.cols : 80;
    const rows = opts.rows && opts.rows > 0 ? opts.rows : 24;
    const cwd = opts.cwd || process.env.HOME || "/";

    let workerSpawnArgs: string[];
    try {
        workerSpawnArgs = resolveWorkerSpawnArgs();
    } catch (err) {
        send({
            type: "terminal_error",
            terminalId,
            message: err instanceof Error ? err.message : String(err),
        });
        return;
    }

    // Spawn the worker with IPC enabled so we can pass structured messages.
    // Each worker owns exactly one PTY; if it crashes it only kills the worker.
    const workerEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        TERMINAL_WORKER_ID:    terminalId,
        TERMINAL_WORKER_CWD:   cwd,
        TERMINAL_WORKER_SHELL: shell,
        TERMINAL_WORKER_COLS:  String(cols),
        TERMINAL_WORKER_ROWS:  String(rows),
    };

    // Point the worker at the native PTY shared library so @zenyr/bun-pty
    // can find it even when running inside a compiled Bun binary.
    if (ptyLibPath) {
        workerEnv.BUN_PTY_LIB = ptyLibPath;
    }

    const worker = spawn(process.execPath, workerSpawnArgs, {
        env: workerEnv,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
    });

    // Surface any stderr from the worker to the daemon log.
    worker.stderr?.on("data", (chunk: Buffer) => {
        console.error(`[terminal ${terminalId}] worker stderr:`, chunk.toString("utf-8").trim());
    });

    let isReady = false;

    worker.on("message", (msg: unknown) => {
        if (!msg || typeof msg !== "object") return;
        const m = msg as Record<string, unknown>;

        switch (m.type) {
            case "ready": {
                isReady = true;
                send({ type: "terminal_ready", terminalId });
                console.log(
                    `pizzapi runner: terminal ${terminalId} spawned (shell=${shell}, cwd=${cwd}, ${cols}x${rows}, pid=${worker.pid})`,
                );
                break;
            }
            case "data": {
                send({ type: "terminal_data", terminalId, data: m.data });
                break;
            }
            case "exit": {
                console.log(
                    `[terminal ${terminalId}] PTY exited (exitCode=${m.exitCode})`,
                );
                runningTerminals.delete(terminalId);
                send({ type: "terminal_exit", terminalId, exitCode: m.exitCode });
                break;
            }
            case "error": {
                if (!isReady) {
                    // Worker failed to spawn the PTY before sending "ready".
                    runningTerminals.delete(terminalId);
                }
                send({ type: "terminal_error", terminalId, message: m.message });
                break;
            }
        }
    });

    worker.on("exit", (code, signal) => {
        const entry = runningTerminals.get(terminalId);
        if (!entry) return; // already removed by "exit" IPC message
        runningTerminals.delete(terminalId);
        console.log(
            `[terminal ${terminalId}] worker exited (code=${code}, signal=${signal})`,
        );
        // If the worker was killed without sending a clean "exit" IPC message
        // (e.g. a Bun C++ panic), synthesize a terminal_exit so the browser
        // knows the session ended.
        send({ type: "terminal_exit", terminalId, exitCode: code ?? 1 });
    });

    worker.on("error", (err) => {
        runningTerminals.delete(terminalId);
        console.error(`[terminal ${terminalId}] worker process error:`, err);
        send({ type: "terminal_error", terminalId, message: err.message });
    });

    const entry: TerminalEntry = {
        terminalId,
        worker,
        startedAt: Date.now(),
    };
    runningTerminals.set(terminalId, entry);
}

/** Write input data (base64-encoded) to a terminal's PTY stdin. */
export function writeTerminalInput(terminalId: string, dataBase64: string): void {
    const entry = runningTerminals.get(terminalId);
    if (!entry) {
        console.warn(`[terminal] writeTerminalInput: no running terminal for terminalId=${terminalId} — input dropped`);
        return;
    }
    try {
        entry.worker.send({ type: "input", data: dataBase64 });
    } catch (err) {
        console.warn(`[terminal] writeTerminalInput: failed for terminalId=${terminalId}:`, err);
    }
}

/** Resize a terminal's PTY. */
export function resizeTerminal(
    terminalId: string,
    cols: number,
    rows: number,
): void {
    const entry = runningTerminals.get(terminalId);
    if (!entry) {
        console.warn(`[terminal] resizeTerminal: no running terminal for terminalId=${terminalId} — resize dropped`);
        return;
    }
    if (cols > 0 && rows > 0) {
        try {
            entry.worker.send({ type: "resize", cols, rows });
        } catch (err) {
            console.warn(`[terminal] resizeTerminal: failed for terminalId=${terminalId}:`, err);
        }
    } else {
        console.warn(`[terminal] resizeTerminal: invalid dimensions ${cols}x${rows} for terminalId=${terminalId} — resize skipped`);
    }
}

/** Kill a terminal's PTY process. */
export function killTerminal(terminalId: string): boolean {
    const entry = runningTerminals.get(terminalId);
    if (!entry) {
        console.warn(`[terminal] killTerminal: no running terminal for terminalId=${terminalId}`);
        return false;
    }
    runningTerminals.delete(terminalId);
    try {
        entry.worker.send({ type: "kill" });
    } catch {}
    try {
        entry.worker.kill("SIGTERM");
    } catch (err) {
        console.warn(`[terminal] killTerminal: worker.kill() failed for terminalId=${terminalId}:`, err);
    }
    return true;
}

/** Get the list of running terminal IDs. */
export function listTerminals(): string[] {
    return Array.from(runningTerminals.keys());
}

/** Kill all running terminals (used on daemon shutdown). */
export function killAllTerminals(): void {
    for (const [id, entry] of runningTerminals) {
        try { entry.worker.send({ type: "kill" }); } catch {}
        try { entry.worker.kill("SIGTERM"); } catch {}
        runningTerminals.delete(id);
    }
}
