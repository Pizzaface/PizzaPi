import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { logInfo, logError } from "./logger.js";

// ── Runner state file (~/.pizzapi/runner.json) ────────────────────────────────
//
// A single JSON file consolidates both the process-lock (pid + startedAt) and
// the persistent runner identity (runnerId + runnerSecret).  This keeps all
// runner state in the canonical ~/.pizzapi/ directory alongside config.json.
//
// Schema:
//   {
//     "pid": 12345,            // PID of the currently-running daemon (lock)
//     "supervisorPid": 12344,  // PID of the outer supervisor process
//     "startedAt": "<iso>",    // ISO timestamp of that daemon start
//     "runnerId": "<uuid>",    // stable runner identity (never changes)
//     "runnerSecret": "<hex>"  // 32-byte secret used to re-authenticate
//   }

export interface RunnerState {
    pid: number;
    supervisorPid?: number;
    startedAt: string;
    runnerId: string;
    runnerSecret: string;
}

export function defaultStatePath(): string {
    return process.env.PIZZAPI_RUNNER_STATE_PATH ?? join(homedir(), ".pizzapi", "runner.json");
}

/**
 * Acquire the runner lock and load (or create) the persistent identity.
 * Both live in a single JSON file so they stay in sync atomically.
 *
 * Returns the identity portion on success; exits the process if another
 * live runner already holds the lock.
 */
export function acquireStateAndIdentity(statePath: string): { runnerId: string; runnerSecret: string } {
    // Ensure the parent directory exists.
    const dir = join(statePath, "..");
    try {
        mkdirSync(dir, { recursive: true });
    } catch {
        // ignore — already exists or unwritable (caught below)
    }

    // Attempt up to two passes: one normal, one after clearing a stale lock.
    for (let attempt = 0; attempt < 2; attempt++) {
        let existing: Partial<RunnerState> = {};
        if (existsSync(statePath)) {
            try {
                existing = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<RunnerState>;
            } catch {
                // Corrupt file — treat as empty, overwrite below.
            }

            // Check whether another live daemon holds the lock.
            const pid = typeof existing.pid === "number" ? existing.pid : NaN;
            if (Number.isFinite(pid) && pid > 0) {
                if (isPidRunning(pid)) {
                    logError(`pizzapi runner already running (pid ${pid}, state: ${statePath}).`);
                    logError("   Stop the existing runner process first, e.g.: kill ${pid}");
                    process.exit(1);
                }
                // PID is gone or belongs to an unrelated process — stale lock.
                logInfo(`clearing stale lock (pid ${pid} is no longer a runner process)`);
            }
        }

        // Write the new lock (preserving identity if already present).
        const runnerId =
            typeof existing.runnerId === "string" && existing.runnerId.length > 0
                ? existing.runnerId
                : randomUUID();
        const runnerSecret =
            typeof existing.runnerSecret === "string" && existing.runnerSecret.length > 0
                ? existing.runnerSecret
                : randomBytes(32).toString("hex");

        const state: RunnerState = {
            pid: process.pid,
            supervisorPid: typeof existing.supervisorPid === "number" ? existing.supervisorPid : undefined,
            startedAt: new Date().toISOString(),
            runnerId,
            runnerSecret,
        };

        try {
            writeFileSync(statePath, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
            return { runnerId, runnerSecret };
        } catch (err: any) {
            logError(`Failed to write runner state to ${statePath}: ${err?.message ?? String(err)}`);
            process.exit(1);
        }
    }

    // Should never reach here.
    process.exit(1);
}

/**
 * Release the process lock by clearing the pid field in the state file,
 * while preserving the persistent identity for the next run.
 */
export function releaseStateLock(statePath: string) {
    try {
        const existing = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<RunnerState>;
        // Only clear the lock fields; keep runnerId + runnerSecret intact.
        const updated = {
            pid: 0,
            supervisorPid: 0,
            startedAt: "",
            runnerId: existing.runnerId ?? "",
            runnerSecret: existing.runnerSecret ?? "",
        };
        writeFileSync(statePath, JSON.stringify(updated, null, 2), { encoding: "utf-8", mode: 0o600 });
    } catch {
        // Best-effort — ignore errors on shutdown.
    }
}

export function isPidRunning(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
    } catch (err: any) {
        // ESRCH = process does not exist. EPERM = exists but no permission.
        if (err?.code === "ESRCH") return false;
        // On Windows, process.kill(pid, 0) throws EPERM when the process exists
        // but we lack permission, and throws with code ESRCH (or sometimes just
        // a generic error) when it doesn't.  If we get here without ESRCH, assume alive.
    }

    // The PID is alive, but it may have been reused by an unrelated process.
    // Verify the command line contains a pizzapi / runner signature.
    try {
        let cmd: string;
        if (process.platform === "win32") {
            // On Windows, use WMIC to inspect the process command line.
            // wmic is available on Windows 7+ and returns the full command line.
            cmd = execFileSync(
                "wmic",
                ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/format:list"],
                { encoding: "utf-8", timeout: 5000 },
            ).trim();
        } else {
            cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8", timeout: 3000 }).trim();
        }
        // Match against known runner process patterns:
        //   - "bun ... runner"          (dev: bun packages/cli/src/index.ts runner)
        //   - "bun ... daemon.ts"       (dev: direct daemon run)
        //   - "bun ... _daemon"         (supervisor-spawned child)
        //   - "pizzapi ... runner"      (production CLI)
        //   - "node ... runner"         (unlikely but possible)
        const isRunner =
            /\brunner\b/i.test(cmd) ||
            /\bdaemon\b/i.test(cmd) ||
            /\bpizzapi\b/i.test(cmd) ||
            /\b_daemon\b/i.test(cmd);
        if (!isRunner) {
            // PID exists but belongs to an unrelated process — stale lock.
            return false;
        }
    } catch {
        // If we can't check the command (e.g. ps/wmic not available), fall back to
        // assuming the process is the runner (safe default — avoids double-start).
    }

    return true;
}
