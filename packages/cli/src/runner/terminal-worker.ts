/**
 * Terminal worker process — one PTY per process.
 *
 * Spawned by terminal.ts for each `new_terminal` request.  Running the PTY
 * in a dedicated subprocess means a crash only takes down this individual
 * terminal, not the entire runner daemon.
 *
 * Uses @zenyr/bun-pty (Rust portable-pty via Bun FFI) instead of node-pty,
 * which has compatibility issues with Bun's runtime on macOS.
 *
 * IPC protocol (JSON newline-delimited over process.send / process.on("message")):
 *
 *   parent → worker:
 *     { type: "input",  data: string }        // base64-encoded bytes to write to PTY
 *     { type: "resize", cols: number, rows: number }
 *     { type: "kill" }
 *
 *   worker → parent:
 *     { type: "ready" }
 *     { type: "data",  data: string }         // base64-encoded PTY output
 *     { type: "exit",  exitCode: number }
 *     { type: "error", message: string }
 *
 * Configuration via environment variables (set by terminal.ts):
 *   TERMINAL_WORKER_ID    - terminalId (informational)
 *   TERMINAL_WORKER_CWD   - working directory
 *   TERMINAL_WORKER_SHELL - shell executable
 *   TERMINAL_WORKER_COLS  - initial columns (default 80)
 *   TERMINAL_WORKER_ROWS  - initial rows (default 24)
 */

import { spawn as spawnPty } from "@zenyr/bun-pty";
import { platform } from "node:os";

const terminalId = process.env.TERMINAL_WORKER_ID ?? "unknown";
const cwd = process.env.TERMINAL_WORKER_CWD || process.env.HOME || "/";
const shell =
    process.env.TERMINAL_WORKER_SHELL ||
    process.env.SHELL ||
    (platform() === "win32" ? "powershell.exe" : "/bin/bash");
const cols = Math.max(1, parseInt(process.env.TERMINAL_WORKER_COLS ?? "80", 10) || 80);
const rows = Math.max(1, parseInt(process.env.TERMINAL_WORKER_ROWS ?? "24", 10) || 24);

function send(msg: Record<string, unknown>): void {
    if (process.send) {
        process.send(msg);
    }
}

// ── Spawn PTY ──────────────────────────────────────────────────────────────────

let ptyProcess: ReturnType<typeof spawnPty>;
try {
    ptyProcess = spawnPty(shell, ["-il"], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: {
            ...process.env,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            // Use Bun's built-in shell for `bun run` scripts instead of
            // /bin/bash, which fails with EBADF in PTY environments.
            // See: https://github.com/oven-sh/bun/issues/21447
            BUN_OPTIONS: [process.env.BUN_OPTIONS, "--shell=bun"].filter(Boolean).join(" "),
        },
    });
} catch (err) {
    send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
}

// Prevent Bun's GC from prematurely collecting the PTY handle.
(globalThis as any).__ptyProcess = ptyProcess;

let ptyAlive = true;

// Forward PTY output → parent
ptyProcess.onData((data: string) => {
    send({ type: "data", data: Buffer.from(data, "utf-8").toString("base64") });
});

ptyProcess.onExit(({ exitCode }: { exitCode: number; signal?: string | number }) => {
    ptyAlive = false;
    send({ type: "exit", exitCode });
    // Give the parent a moment to receive the exit message before we quit.
    setTimeout(() => process.exit(0), 200);
});

// Notify parent that the PTY is ready
send({ type: "ready" });

// ── Receive commands from parent ───────────────────────────────────────────────

process.on("message", (msg: unknown) => {
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;

    switch (m.type) {
        case "input": {
            if (!ptyAlive) break;
            const data = typeof m.data === "string" ? Buffer.from(m.data, "base64").toString("utf-8") : "";
            if (data) {
                try {
                    ptyProcess.write(data);
                } catch {
                    // PTY may have already exited — ignore write errors.
                }
            }
            break;
        }
        case "resize": {
            if (!ptyAlive) break;
            const c = typeof m.cols === "number" && m.cols > 0 ? m.cols : 80;
            const r = typeof m.rows === "number" && m.rows > 0 ? m.rows : 24;
            try {
                ptyProcess.resize(c, r);
            } catch (err) {
                // PTY fd may already be closed (shell exited). Ignore.
                const errMsg = err instanceof Error ? err.message : String(err);
                if (!errMsg.includes("EBADF")) {
                    console.error(`[terminal ${terminalId}] resize error: ${errMsg}`);
                }
            }
            break;
        }
        case "kill": {
            try { ptyProcess.kill(); } catch {}
            process.exit(0);
            break;
        }
    }
});

// If the parent dies, so should we.
process.on("disconnect", () => {
    try { ptyProcess.kill(); } catch {}
    process.exit(0);
});
