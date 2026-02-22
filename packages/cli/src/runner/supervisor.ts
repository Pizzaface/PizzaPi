/**
 * Outer supervisor for the PizzaPi runner daemon.
 *
 * The daemon uses native PTY functionality (via @zenyr/bun-pty) and isolates
 * each terminal in its own worker subprocess.  If a worker or the daemon
 * itself crashes, a JavaScript try/catch cannot intercept a native-level
 * panic, so a same-process restart loop is not enough.
 *
 * This supervisor solves the problem by running the daemon as a **child
 * process**.  If the child is killed by a crash or any other unhandled
 * signal, the supervisor detects the non-zero exit and re-spawns it with
 * exponential back-off — without any downtime for the supervisor itself.
 *
 * Restart semantics:
 *   exit 0   → clean stop; supervisor exits 0
 *   exit 42  → daemon requested a self-restart (e.g. /restart command)
 *              → supervisor re-spawns immediately with reset back-off
 *   any other non-zero / signal → crash; supervisor waits back-off then restarts
 *
 * Signals:
 *   SIGINT / SIGTERM received by the supervisor are forwarded to the child so
 *   the daemon can shut down cleanly (release its state lock, close sockets,
 *   etc.).  After forwarding we wait for the child to exit before resolving.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RESTART_DELAY_BASE = 2_000;  // 2 s
const RESTART_DELAY_MAX  = 60_000; // 60 s

export async function runSupervisor(_args: string[] = []): Promise<number> {
    // Resolve the CLI entry point so we can re-spawn it with `_daemon`.
    // Works both from TypeScript source (bun run dev:runner) and from the
    // compiled dist (bun runner).
    const ext       = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const cliEntry  = fileURLToPath(new URL(`../index.${ext}`, import.meta.url));
    if (!existsSync(cliEntry)) {
        const alt = fileURLToPath(new URL(`../index.${ext === "ts" ? "js" : "ts"}`, import.meta.url));
        if (!existsSync(alt)) {
            throw new Error(`Cannot locate CLI entry point: ${cliEntry}`);
        }
    }

    let restartDelay = RESTART_DELAY_BASE;
    let isShuttingDown = false;
    let child: ChildProcess | null = null;

    // Forward SIGINT / SIGTERM to the child so it can release its lock file
    // and close its WebSocket before we restart or exit.
    const forwardSignal = (sig: NodeJS.Signals) => {
        isShuttingDown = true;
        if (child && !child.killed) {
            try { child.kill(sig); } catch {}
        }
    };
    process.on("SIGINT",  () => forwardSignal("SIGINT"));
    process.on("SIGTERM", () => forwardSignal("SIGTERM"));

    console.log("pizzapi supervisor: starting runner daemon as subprocess…");

    while (true) {
        const exitCode = await new Promise<number>((resolve) => {
            child = spawn(process.execPath, [cliEntry, "_daemon"], {
                env:   process.env as Record<string, string>,
                stdio: ["ignore", "inherit", "inherit"],
            });

            child.on("exit", (code, signal) => {
                const effective = code ?? (signal ? 1 : 0);
                resolve(effective);
            });

            child.on("error", (err) => {
                console.error("pizzapi supervisor: failed to spawn daemon child:", err);
                resolve(1);
            });
        });

        child = null;

        if (isShuttingDown) {
            console.log("pizzapi supervisor: shutdown requested — exiting.");
            return 0;
        }

        if (exitCode === 0) {
            console.log("pizzapi supervisor: daemon exited cleanly.");
            return 0;
        }

        if (exitCode === 42) {
            // Daemon requested a self-restart (e.g. via /restart command).
            console.log("pizzapi supervisor: daemon requested restart — re-spawning immediately…");
            restartDelay = RESTART_DELAY_BASE; // reset back-off
            continue;
        }

        // Crash or unexpected exit — apply back-off then restart.
        console.error(
            `pizzapi supervisor: daemon exited with code ${exitCode}. ` +
            `Restarting in ${(restartDelay / 1000).toFixed(0)}s…`
        );
        await new Promise((r) => setTimeout(r, restartDelay));
        restartDelay = Math.min(restartDelay * 2, RESTART_DELAY_MAX);

        if (isShuttingDown) return 0;
        console.log("pizzapi supervisor: re-spawning daemon…");
    }
}
