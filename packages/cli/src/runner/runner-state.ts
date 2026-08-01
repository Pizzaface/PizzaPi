import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { logInfo, logError, logWarn } from "./logger.js";

// ── Runner state file (~/.pizzapi/runner.json) ────────────────────────────────
//
// A single JSON file consolidates both the process-lock (pid + startedAt) and
// the persistent runner identity (runnerId + runnerSecret).  This keeps all
// runner state in the canonical ~/.pizzapi/ directory alongside config.json.
//
// Schema:
//   {
//     "pid": 12345,            // PID of the currently-running daemon (lock)
//     "pidStartTime": "...",   // OS-reported start time of `pid`, used to detect PID reuse (see getPidStartTime)
//     "supervisorPid": 12344,  // PID of the outer supervisor process
//     "startedAt": "<iso>",    // ISO timestamp of that daemon start
//     "runnerId": "<uuid>",    // stable runner identity (never changes)
//     "runnerSecret": "<hex>", // 32-byte secret used to re-authenticate
//     "connected": true,       // whether the daemon is currently registered with the relay
//     "connectedAt": "<iso>",  // when the last successful registration happened
//     "disconnectedAt": "<iso>", // when the socket last dropped
//     "relayUrl": "...",       // relay URL the daemon is registered against
//     "runnerName": "...",     // display name reported at registration
//     "cliVersion": "..."      // CLI version reported at registration
//   }

export interface RunnerState {
    pid: number;
    pidStartTime?: string;
    supervisorPid?: number;
    startedAt: string;
    runnerId: string;
    runnerSecret: string;
    connected?: boolean;
    connectedAt?: string;
    disconnectedAt?: string;
    relayUrl?: string;
    runnerName?: string;
    cliVersion?: string;
}

export function defaultStatePath(): string {
    return process.env.PIZZAPI_RUNNER_STATE_PATH ?? join(homedir(), ".pizzapi", "runner.json");
}

/**
 * Get an OS-reported start time for `pid`, used to detect PID reuse.
 *
 * Why this matters: a freshly-started container resets its PID namespace to
 * 1 every time, and with nothing else running before the daemon, its own
 * process tree (tini -> supervisor -> daemon) gets the same deterministic
 * low PIDs on every start. That means a stale lock left by a killed
 * container's daemon can have the *exact* PID number the next container's
 * brand-new daemon also gets assigned — PID liveness + cmdline pattern
 * matching alone can't tell "still the same process" from "coincidentally
 * reused PID", since both look identical. Start time can: the kernel's
 * boot-relative clock keeps advancing across container restarts (they share
 * the host kernel), so a reused PID always has a later start time than the
 * dead process that had it before.
 *
 * Returns null when unavailable or unparseable — callers must treat that as
 * "can't tell" and fall back to the existing PID+cmdline heuristic.
 */
export function getPidStartTime(pid: number): string | null {
    if (process.platform === "linux") {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
            // Fields after the executable name (in parens, which may itself
            // contain spaces/parens) are space-separated starting at field 3
            // (state). The comm field always ends at the LAST ")" on the line.
            const closeParen = stat.lastIndexOf(")");
            if (closeParen === -1) return null;
            const rest = stat.slice(closeParen + 1).trim().split(/\s+/);
            // rest[0] is field 3 (state), so field 22 (starttime) is rest[19].
            const starttime = rest[19];
            return starttime && /^\d+$/.test(starttime) ? starttime : null;
        } catch {
            return null;
        }
    }
    try {
        // macOS/BSD: wall-clock process start time (ticks-since-boot isn't
        // exposed the same way, but lstart is equally stable across reuse).
        const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf-8", timeout: 3000 }).trim();
        return out || null;
    } catch {
        return null;
    }
}

/**
 * Pure decision: does a matching PID + cmdline actually mean "same process"?
 * Only says yes (reused) when we have BOTH a recorded and a freshly-read
 * start time and they disagree — any missing value means "can't tell", which
 * must fall back to treating the PID as still live (the old, safe behavior).
 */
export function isPidReused(recordedStartTime: string | null | undefined, currentStartTime: string | null): boolean {
    return recordedStartTime != null && currentStartTime != null && currentStartTime !== recordedStartTime;
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
                    // Liveness + cmdline alone can be fooled by PID reuse (see
                    // getPidStartTime). If we recorded a start time last run
                    // and can read one now, a mismatch means this is a
                    // different process that just landed on the same PID.
                    const pidWasReused = isPidReused(existing.pidStartTime, getPidStartTime(pid));
                    if (!pidWasReused) {
                        logError(`pizzapi runner already running (pid ${pid}, state: ${statePath}).`);
                        logError(`   Stop the existing runner process first, e.g.: kill ${pid}`);
                        process.exit(1);
                    }
                    logInfo(`clearing stale lock (pid ${pid} was reused by a different process since state was last written)`);
                } else {
                    // PID is gone — stale lock.
                    logInfo(`clearing stale lock (pid ${pid} is no longer a runner process)`);
                }
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
            pidStartTime: getPidStartTime(process.pid) ?? undefined,
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

/**
 * Read-modify-write a partial patch onto the state file, preserving any
 * fields this process doesn't know about. Used by the daemon to record
 * relay connection state (connected/connectedAt/...) without racing the
 * pid-lock fields above.
 *
 * Best-effort: never throws. Writes via temp-file + rename in the same
 * directory so a concurrent `runner status` read never sees a truncated file.
 */
export function patchRunnerState(statePath: string, patch: Partial<RunnerState>): void {
    try {
        let existing: Partial<RunnerState> = {};
        if (existsSync(statePath)) {
            try {
                existing = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<RunnerState>;
            } catch {
                // Corrupt file — overwrite with just the patch below.
            }
        }
        const updated = { ...existing, ...patch };
        const tmpPath = `${statePath}.tmp-${process.pid}`;
        writeFileSync(tmpPath, JSON.stringify(updated, null, 2), { encoding: "utf-8", mode: 0o600 });
        renameSync(tmpPath, statePath);
    } catch (err: any) {
        logWarn(`Failed to patch runner state at ${statePath}: ${err?.message ?? String(err)}`);
    }
}

export function isPidRunning(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
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
            // wmic is removed from Windows 11 24H2+, so query CIM via PowerShell.
            cmd = execFileSync(
                "powershell.exe",
                [
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
                ],
                { encoding: "utf-8", timeout: 10000, windowsHide: true },
            ).trim();
            // Empty output: the process is gone, or its command line is not ours
            // to read (another user's / a system process). The runner always runs
            // as the current user, so either way this PID is not the runner.
            if (cmd.length === 0) return false;
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
