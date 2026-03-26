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

import { existsSync, readFileSync } from "node:fs";
import { logError, logInfo, logWarn, setLogComponent } from "./logger.js";
import { defaultStatePath, isPidRunning } from "./runner-state.js";

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

    // Still alive — force kill.
    // On Windows, SIGKILL is not supported; use SIGTERM which unconditionally
    // terminates the process on Windows (equivalent to SIGKILL on Unix).
    const forceSignal = process.platform === "win32" ? "SIGTERM" : "SIGKILL";
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
