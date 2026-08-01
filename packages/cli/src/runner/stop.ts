/**
 * `runner stop` — Gracefully stop the running PizzaPi runner daemon.
 *
 * Reads the supervisor PID from the state file (~/.pizzapi/runner.json) and
 * sends SIGTERM.  The supervisor forwards the signal to the daemon child,
 * which releases its lock and disconnects cleanly before both exit.
 *
 * If no supervisor PID is recorded (older state file), falls back to sending
 * SIGTERM to the daemon PID directly.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logError, logInfo, logWarn, setLogComponent } from "./logger.js";
import { defaultStatePath, isPidRunning } from "./runner-state.js";
import { STOP_FILE_NAME } from "./process-kill.js";

/** Cheap liveness probe for wait loops (no command-line verification). */
function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: any) {
        return err?.code !== "ESRCH";
    }
}

/** Hard-kill a PID and its process tree on Windows. */
function taskkillTree(pid: number): void {
    try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 10_000 });
    } catch {
        try { process.kill(pid, "SIGTERM"); } catch {}
    }
}

/**
 * Windows stop flow. Signals are undeliverable (TerminateProcess only), so a
 * stop file is dropped next to the state file; the daemon polls for it, shuts
 * down cleanly (releasing its lock and closing the tunnel), and the supervisor
 * observes the clean exit and follows. Falls back to a tree force-kill.
 */
async function runStopWindows(statePath: string, supervisorPid: number, daemonPid: number): Promise<number> {
    const stopFile = join(dirname(statePath), STOP_FILE_NAME);
    let stopFileWritten = false;
    try {
        writeFileSync(stopFile, new Date().toISOString(), "utf-8");
        stopFileWritten = true;
        logInfo("Requested graceful shutdown (stop file)…");
    } catch (err: any) {
        logWarn(`Could not write stop file: ${err?.message ?? String(err)}`);
    }

    if (stopFileWritten) {
        // Daemon polls every 1 s; give it time to clean up sessions + tunnel.
        const deadline = Date.now() + 12_000;
        while (Date.now() < deadline) {
            if (!pidAlive(daemonPid) && !pidAlive(supervisorPid)) {
                try { rmSync(stopFile, { force: true }); } catch {}
                logInfo("Runner stopped.");
                return 0;
            }
            await new Promise((r) => setTimeout(r, 250));
        }
        logWarn("Runner did not exit in time. Force-killing…");
    }

    try { rmSync(stopFile, { force: true }); } catch {}
    for (const pid of [supervisorPid, daemonPid]) {
        if (pid > 0 && pidAlive(pid)) taskkillTree(pid);
    }
    logInfo("Runner force-stopped.");
    return 0;
}

export async function runStop(): Promise<number> {
    setLogComponent("supervisor");
    const statePath = defaultStatePath();

    if (!existsSync(statePath)) {
        logError("No runner state file found. Is a runner running?");
        return 1;
    }

    let state: {
        pid?: number;
        supervisorPid?: number;
        runnerId?: string;
    };
    try {
        state = JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {
        logError(`Failed to read runner state from ${statePath}`);
        return 1;
    }

    // Prefer the supervisor PID — killing it stops the entire process tree
    // (supervisor forwards SIGTERM to daemon, daemon cleans up and exits).
    const supervisorPid = typeof state.supervisorPid === "number" ? state.supervisorPid : 0;
    const daemonPid = typeof state.pid === "number" ? state.pid : 0;

    const targetPid = supervisorPid > 0 && isPidRunning(supervisorPid)
        ? supervisorPid
        : daemonPid > 0 && isPidRunning(daemonPid)
            ? daemonPid
            : 0;

    if (targetPid === 0) {
        logInfo("No running runner process found.");
        return 0;
    }

    const label = targetPid === supervisorPid ? "supervisor" : "daemon";
    logInfo(`Stopping runner ${label} (pid ${targetPid})…`);

    if (process.platform === "win32") {
        // SIGTERM here would TerminateProcess the supervisor and orphan the
        // daemon (no signal forwarding exists on Windows) — use the stop file.
        return runStopWindows(statePath, supervisorPid, daemonPid);
    }

    try {
        process.kill(targetPid, "SIGTERM");
    } catch (err: any) {
        if (err?.code === "ESRCH") {
            logInfo("Process already exited.");
            return 0;
        }
        logError(`Failed to send SIGTERM: ${err?.message ?? String(err)}`);
        return 1;
    }

    // Wait up to 10 seconds for the process to exit.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (!isPidRunning(targetPid)) {
            logInfo("Runner stopped.");
            return 0;
        }
        await new Promise((r) => setTimeout(r, 250));
    }

    // Still alive — force kill. (Windows exits above via runStopWindows.)
    const forceSignal = "SIGKILL";
    logWarn("Runner did not exit in time. Force-killing…");
    try {
        process.kill(targetPid, forceSignal);
    } catch { /* ignore */ }

    // Also kill the daemon if we killed the supervisor
    if (targetPid === supervisorPid && daemonPid > 0 && isPidRunning(daemonPid)) {
        try {
            process.kill(daemonPid, forceSignal);
        } catch { /* ignore */ }
    }

    logInfo("Runner force-stopped.");
    return 0;
}
