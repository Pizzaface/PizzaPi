import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireStateAndIdentity, releaseStateLock } from "./runner-state.js";

/**
 * Regression coverage for the supervisor/daemon state-file contract across a
 * code-42 restart. The supervisor is the parent that stays alive; the daemon
 * is the child that exits and is re-spawned. The state file must keep a valid
 * supervisorPid so `runner stop` can target the supervisor, otherwise a
 * force-kill of the daemon leaves the supervisor alive and the runner restarts.
 */
describe("supervisor state lifecycle", () => {
    let tmpHome: string;
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        tmpHome = mkdtempSync(join(tmpdir(), "supervisor-state-test-"));
        process.env.HOME = tmpHome;
    });

    afterEach(() => {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        rmSync(tmpHome, { recursive: true, force: true });
    });

    test("daemon restart (exit 42) must preserve a valid supervisorPid in state file", () => {
        const statePath = join(tmpHome, ".pizzapi", "runner.json");
        mkdirSync(join(tmpHome, ".pizzapi"), { recursive: true });

        // Pretend the supervisor has been running and wrote its PID. The daemon
        // PID is stale (not running) so acquireStateAndIdentity will replace it.
        const supervisorPid = 55555;
        writeFileSync(
            statePath,
            JSON.stringify(
                {
                    pid: 999999,
                    supervisorPid,
                    startedAt: "2024-01-01T00:00:00.000Z",
                    runnerId: "runner-123",
                    runnerSecret: "secret-abc",
                },
                null,
                2,
            ),
        );

        // Simulate the daemon shutting down for a code-42 restart. The supervisor
        // is still alive, so supervisorPid must remain valid for `runner stop`.
        releaseStateLock(statePath);
        let state = JSON.parse(readFileSync(statePath, "utf-8"));
        expect(state.supervisorPid).toBe(supervisorPid);

        // The new daemon starts and re-acquires the lock. It must inherit the
        // still-valid supervisor PID, not silently drop it.
        const identity = acquireStateAndIdentity(statePath);
        state = JSON.parse(readFileSync(statePath, "utf-8"));

        expect(identity.runnerId).toBe("runner-123");
        expect(state.pid).toBe(process.pid);
        expect(state.supervisorPid).toBe(supervisorPid);
    });

    test("acquireStateAndIdentity must treat supervisorPid 0 as absent, not valid", () => {
        const statePath = join(tmpHome, ".pizzapi", "runner.json");
        mkdirSync(join(tmpHome, ".pizzapi"), { recursive: true });

        // A previous releaseStateLock wrote supervisorPid: 0. Zero is not a valid
        // PID and must not be preserved, otherwise `runner stop` thinks a
        // supervisor exists when it does not.
        writeFileSync(
            statePath,
            JSON.stringify(
                {
                    pid: 0,
                    supervisorPid: 0,
                    startedAt: "",
                    runnerId: "runner-123",
                    runnerSecret: "secret-abc",
                },
                null,
                2,
            ),
        );

        acquireStateAndIdentity(statePath);
        const state = JSON.parse(readFileSync(statePath, "utf-8"));

        expect(state.supervisorPid).not.toBe(0);
        expect(state.supervisorPid).toBeUndefined();
    });
});
