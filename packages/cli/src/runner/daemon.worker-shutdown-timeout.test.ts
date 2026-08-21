import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Health-inspection test (Lane A1): worker shutdown budget mismatch.
 *
 * When a worker is killed via `kill_session`, the daemon waits
 * `SESSION_SHUTDOWN_GRACE_MS` and then SIGKILLs the worker process group. The
 * worker, meanwhile, runs its own SIGTERM handler with a hard-exit timer of
 * `hardExitTimeoutMs`. If the daemon's SIGKILL timeout is shorter than the
 * worker's hard-exit timeout, the daemon terminates the worker before the
 * worker's own deadline fires. This makes the worker's internal hard timer
 * ineffective in the daemon-controlled path and can cut short
 * `session.dispose()` cleanup.
 *
 * Code paths:
 *   - packages/cli/src/runner/daemon.ts:421  `SESSION_SHUTDOWN_GRACE_MS = 8_000`
 *   - packages/cli/src/runner/daemon.ts:429  `escalateToSigkill(..., timeoutMs = SESSION_SHUTDOWN_GRACE_MS)`
 *   - packages/cli/src/runner/daemon.ts:1872-1875  `kill_session` calls escalateToSigkill with 8s
 *   - packages/cli/src/runner/worker.ts:834  `const hardExitTimeoutMs = 10_000`
 *   - packages/cli/src/runner/worker.ts:836-839  hard timer calls `process.exit(0)` after that budget
 *
 * This is distinct from the adopted-session process-registry cleanup finding.
 */
describe("daemon worker shutdown timeout alignment", () => {
    const daemonSource = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
    const workerSource = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");

    function extractInt(source: string, name: string): number {
        const match = source.match(new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*(\\d[\\d_]*);`));
        if (!match) throw new Error(`Could not extract ${name}`);
        return Number(match[1].replace(/_/g, ""));
    }

    test("daemon SIGKILL escalation timeout covers worker hard-exit deadline", () => {
        const daemonGraceMs = extractInt(daemonSource, "SESSION_SHUTDOWN_GRACE_MS");
        const workerHardExitMs = extractInt(workerSource, "hardExitTimeoutMs");

        expect(daemonGraceMs).toBeGreaterThanOrEqual(workerHardExitMs);
    });
});
