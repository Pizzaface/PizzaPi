import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchRunnerState } from "./runner-state.js";
import { evaluateRunnerStatus } from "./status.js";

const alive = (_pid: number) => true;
const dead = (_pid: number) => false;

describe("evaluateRunnerStatus", () => {
    test("healthy: state exists, pid alive, connected", () => {
        const result = evaluateRunnerStatus(
            { pid: 123, connected: true, startedAt: "2024-01-01T00:00:00.000Z", runnerId: "r1" },
            alive,
        );
        expect(result.healthy).toBe(true);
        expect(result.reason).toBeUndefined();
        expect(result.connected).toBe(true);
    });

    test("unhealthy: no state file", () => {
        const result = evaluateRunnerStatus(null, alive);
        expect(result.healthy).toBe(false);
        expect(result.reason).toBe("no runner state file found");
    });

    test("unhealthy: dead pid", () => {
        const result = evaluateRunnerStatus({ pid: 123, connected: true }, dead);
        expect(result.healthy).toBe(false);
        expect(result.reason).toBe("process not running");
    });

    test("unhealthy: connected false", () => {
        const result = evaluateRunnerStatus({ pid: 123, connected: false }, alive);
        expect(result.healthy).toBe(false);
        expect(result.reason).toBe("not registered with relay");
    });

    test("unhealthy: connected missing entirely (never registered)", () => {
        const result = evaluateRunnerStatus({ pid: 123 }, alive);
        expect(result.healthy).toBe(false);
        expect(result.reason).toBe("not registered with relay");
    });

    test("unhealthy: no pid recorded", () => {
        const result = evaluateRunnerStatus({ connected: true }, alive);
        expect(result.healthy).toBe(false);
        expect(result.reason).toBe("process not running");
    });
});

describe("patchRunnerState", () => {
    let tmpHome: string;
    let statePath: string;

    beforeEach(() => {
        tmpHome = mkdtempSync(join(tmpdir(), "runner-status-test-"));
        mkdirSync(join(tmpHome, ".pizzapi"), { recursive: true });
        statePath = join(tmpHome, ".pizzapi", "runner.json");
    });

    afterEach(() => {
        rmSync(tmpHome, { recursive: true, force: true });
    });

    test("preserves unknown fields while merging the patch", () => {
        writeFileSync(
            statePath,
            JSON.stringify({ pid: 1, runnerId: "r1", runnerSecret: "s1", startedAt: "t0" }, null, 2),
        );

        patchRunnerState(statePath, { connected: true, connectedAt: "2024-01-01T00:00:00.000Z" });

        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        expect(state).toMatchObject({
            pid: 1,
            runnerId: "r1",
            runnerSecret: "s1",
            startedAt: "t0",
            connected: true,
            connectedAt: "2024-01-01T00:00:00.000Z",
        });
    });

    test("creates the file if it doesn't exist yet", () => {
        patchRunnerState(statePath, { connected: false });
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        expect(state).toEqual({ connected: false });
    });

    test("never throws on an unwritable path", () => {
        expect(() => patchRunnerState(join(tmpHome, "no-such-dir", "runner.json"), { connected: true })).not.toThrow();
    });
});
