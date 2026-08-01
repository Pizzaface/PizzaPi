/**
 * `runner status [--json]` — health probe for the running PizzaPi runner daemon.
 *
 * Answers "is this runner alive AND registered with the relay?" by combining
 * a PID liveness check with the `connected` flag the daemon patches into the
 * state file on register/disconnect (see runner-state.ts / daemon.ts).
 *
 * Exit 0 = healthy, exit 1 = not — this is what a Docker HEALTHCHECK
 * consumes, so this command stays fast and dependency-light: no relay
 * round-trip, no config/model loading, no dynamic import of the daemon.
 */

import { existsSync, readFileSync } from "node:fs";
import { c } from "../cli-colors.js";
import { defaultStatePath, isPidRunning, type RunnerState } from "./runner-state.js";
import { formatDuration } from "./services/time-utils.js";

export interface RunnerStatusResult {
    healthy: boolean;
    reason?: string;
    runnerId?: string;
    runnerName?: string;
    relayUrl?: string;
    connected: boolean;
    pid?: number;
    startedAt?: string;
    cliVersion?: string;
}

/**
 * Pure decision logic, factored out so tests don't need real processes.
 * `isAlive` is injected (normally `isPidRunning`) for the same reason.
 */
export function evaluateRunnerStatus(
    state: Partial<RunnerState> | null,
    isAlive: (pid: number) => boolean,
): RunnerStatusResult {
    if (!state) {
        return { healthy: false, reason: "no runner state file found", connected: false };
    }

    const pid = typeof state.pid === "number" ? state.pid : 0;
    const base: RunnerStatusResult = {
        healthy: false,
        runnerId: state.runnerId,
        runnerName: state.runnerName,
        relayUrl: state.relayUrl,
        connected: state.connected === true,
        pid: pid || undefined,
        startedAt: state.startedAt,
        cliVersion: state.cliVersion,
    };

    if (!pid || !isAlive(pid)) {
        return { ...base, reason: "process not running" };
    }
    if (state.connected !== true) {
        return { ...base, reason: "not registered with relay" };
    }
    return { ...base, healthy: true };
}

function readState(statePath: string): Partial<RunnerState> | null {
    if (!existsSync(statePath)) return null;
    try {
        return JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {
        return null;
    }
}

export async function runStatus(args: string[] = []): Promise<number> {
    const asJson = args.includes("--json");
    const statePath = defaultStatePath();
    const state = readState(statePath);
    const result = evaluateRunnerStatus(state, isPidRunning);

    if (asJson) {
        console.log(JSON.stringify(result, null, 2));
        return result.healthy ? 0 : 1;
    }

    if (!state) {
        console.log(c.error("Runner not running.") + c.dim(` (${result.reason})`));
        return 1;
    }

    const uptime = result.startedAt
        ? formatDuration(Date.now() - new Date(result.startedAt).getTime())
        : c.dim("unknown");
    console.log(`${c.bold(result.runnerName ?? "runner")} ${c.dim(result.runnerId ?? "unknown")}`);
    console.log(`  ${c.dim("relay")}      ${result.relayUrl ?? c.dim("unknown")}`);
    console.log(`  ${c.dim("connected")}  ${result.connected ? c.success("true") : c.error("false")}`);
    console.log(`  ${c.dim("uptime")}     ${uptime}`);
    console.log(`  ${c.dim("pid")}        ${result.pid ?? c.dim("unknown")}`);
    console.log(`  ${c.dim("version")}    ${result.cliVersion ?? c.dim("unknown")}`);
    if (!result.healthy) {
        console.log(c.warning(`unhealthy: ${result.reason}`));
    }

    return result.healthy ? 0 : 1;
}
