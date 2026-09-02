/**
 * Regression tests for the supervisor restart-on-shutdown race condition (A1-013).
 *
 * Race: SIGTERM arrives AFTER child exits with code 42 but BEFORE the
 * supervisor re-spawns. Without the guard the supervisor would respawn anyway.
 */
import { afterEach, describe, expect, test, mock } from "bun:test";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake ChildProcess returned by the mocked spawn(). */
function makeChild() {
    const ee = new EventEmitter() as EventEmitter & {
        killed: boolean;
        exitCode: number | null;
        kill: (sig?: string) => void;
        connected: boolean;
    };
    ee.killed = false;
    ee.exitCode = null;
    ee.connected = false;
    ee.kill = (_sig?: string) => { ee.killed = true; };
    return ee;
}

// ---------------------------------------------------------------------------
// Module mocks (must be declared before the dynamic import below)
// ---------------------------------------------------------------------------

const children: ReturnType<typeof makeChild>[] = [];
let spawnCallCount = 0;

mock.module("node:child_process", () => ({
    spawn: (_exe: string, _args: string[], _opts: unknown) => {
        spawnCallCount++;
        const child = makeChild();
        children.push(child);
        return child;
    },
}));

mock.module("node:fs", () => ({
    // Return true so cliEntry resolution passes; writeFileSync/readFileSync are no-ops.
    existsSync: () => true,
    readFileSync: () => "{}",
    writeFileSync: () => undefined,
}));

mock.module("../config.js", () => ({
    resolveAgentDir: () => "/tmp/fake-agent-dir",
}));

mock.module("./pairing.js", () => ({
    ensureRunnerCredentials: async () => null, // null = credentials OK, proceed
}));

mock.module("./runner-state.js", () => ({
    defaultStatePath: () => "/tmp/fake-runner-state.json",
}));

mock.module("./logger.js", () => ({
    setLogComponent: () => undefined,
    logInfo: () => undefined,
    logError: () => undefined,
}));

mock.module("./process-kill.js", () => ({
    forceKillTree: () => undefined,
    SHUTDOWN_MESSAGE: "__shutdown__",
}));

// ---------------------------------------------------------------------------
// Import under test AFTER mocks are registered
// ---------------------------------------------------------------------------

const { runSupervisor } = await import("./supervisor.js");

// ---------------------------------------------------------------------------
// Test cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
    spawnCallCount = 0;
    children.length = 0;
    // Remove any SIGINT/SIGTERM listeners added during the test to avoid
    // cross-test interference.
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("supervisor restart race condition (A1-013)", () => {
    test("exit-42 WITHOUT shutdown → supervisor respawns", async () => {
        const done = runSupervisor([]);

        // Wait for the first spawn.
        await waitForSpawn(1);
        const first = children[0];

        // Child exits with code 42 (restart request).
        first.emit("exit", 42, null);

        // Wait for the second spawn (restart).
        await waitForSpawn(2);
        const second = children[1];

        // End the loop cleanly.
        second.emit("exit", 0, null);

        const code = await done;
        expect(code).toBe(0);
        expect(spawnCallCount).toBe(2); // initial + one restart
    });

    test("exit-42 WITH shutdown flag set before respawn → no respawn", async () => {
        const done = runSupervisor([]);

        // Wait for the first spawn.
        await waitForSpawn(1);
        const first = children[0];

        // Simulate: shutdown arrives (SIGTERM) just before the exit event fires.
        // process.emit triggers the forwardSignal handler registered inside runSupervisor.
        process.emit("SIGTERM");

        // Now the child exits with code 42.
        first.emit("exit", 42, null);

        const code = await done;
        expect(code).toBe(0);
        // Only one spawn — the restart was suppressed.
        expect(spawnCallCount).toBe(1);
    });

    test("exit-42 WITH shutdown flag set after exit but before next tick → no respawn", async () => {
        const done = runSupervisor([]);

        await waitForSpawn(1);
        const first = children[0];

        // Emit exit first, then synchronously emit SIGTERM before microtasks flush.
        first.emit("exit", 42, null);
        // The exit-42 branch runs synchronously after the exit event, but we
        // can set the flag by emitting SIGTERM — any timing where the flag is
        // set before the guard runs is covered by the earlier test. Here we
        // explicitly test: flag already true from a prior shutdown path.
        // We re-run with pre-set shutdown to confirm no double-spawn occurs.
        // (Signal emission after exit is the exact race window from the bug.)
        process.emit("SIGTERM");

        // Give the promise chain a chance to resolve (one tick).
        await new Promise<void>((r) => setImmediate(r));

        // Regardless of whether we ended via the 42-guard or the later
        // isShuttingDown check, there must be no second spawn.
        const code = await done;
        expect(code).toBe(0);
        expect(spawnCallCount).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Poll until `spawnCallCount >= n` or timeout (1 s). */
async function waitForSpawn(n: number, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (spawnCallCount < n) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for spawn #${n}`);
        await new Promise<void>((r) => setImmediate(r));
    }
}
