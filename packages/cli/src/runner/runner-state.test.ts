import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireStateAndIdentity, isPidRunning, releaseStateLock } from "./runner-state.js";

describe("runner-state", () => {
    let tmpHome: string;
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        tmpHome = mkdtempSync(join(tmpdir(), "runner-state-test-"));
        process.env.HOME = tmpHome;
    });

    afterEach(() => {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        rmSync(tmpHome, { recursive: true, force: true });
    });

    test("acquireStateAndIdentity creates a new state file with persistent identity", () => {
        const statePath = join(tmpHome, ".pizzapi", "runner.json");

        const identity = acquireStateAndIdentity(statePath);
        const state = JSON.parse(readFileSync(statePath, "utf-8"));

        expect(identity.runnerId).toBeString();
        expect(identity.runnerSecret).toBeString();
        expect(state.pid).toBe(process.pid);
        expect(state.runnerId).toBe(identity.runnerId);
        expect(state.runnerSecret).toBe(identity.runnerSecret);
        expect(typeof state.startedAt).toBe("string");
    });

    test("acquireStateAndIdentity replaces stale lock data but preserves identity", () => {
        const statePath = join(tmpHome, ".pizzapi", "runner.json");
        mkdirSync(join(tmpHome, ".pizzapi"), { recursive: true });
        writeFileSync(
            statePath,
            JSON.stringify(
                {
                    pid: 999999,
                    supervisorPid: 123,
                    startedAt: "2024-01-01T00:00:00.000Z",
                    runnerId: "runner-123",
                    runnerSecret: "secret-abc",
                },
                null,
                2,
            ),
        );

        const identity = acquireStateAndIdentity(statePath);
        const state = JSON.parse(readFileSync(statePath, "utf-8"));

        expect(identity).toEqual({ runnerId: "runner-123", runnerSecret: "secret-abc" });
        expect(state.pid).toBe(process.pid);
        expect(state.supervisorPid).toBe(123);
        expect(state.runnerId).toBe("runner-123");
        expect(state.runnerSecret).toBe("secret-abc");
        expect(state.startedAt).not.toBe("2024-01-01T00:00:00.000Z");
    });

    test("releaseStateLock clears lock fields without deleting persistent identity", () => {
        const statePath = join(tmpHome, ".pizzapi", "runner.json");
        mkdirSync(join(tmpHome, ".pizzapi"), { recursive: true });
        writeFileSync(
            statePath,
            JSON.stringify(
                {
                    pid: 321,
                    supervisorPid: 654,
                    startedAt: "2024-01-01T00:00:00.000Z",
                    runnerId: "runner-123",
                    runnerSecret: "secret-abc",
                },
                null,
                2,
            ),
        );

        releaseStateLock(statePath);

        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        expect(state).toEqual({
            pid: 0,
            supervisorPid: 0,
            startedAt: "",
            runnerId: "runner-123",
            runnerSecret: "secret-abc",
        });
    });

    test("isPidRunning rejects invalid or stale pids and accepts runner-like processes", async () => {
        const runner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "runner-lock"]);

        try {
            expect(isPidRunning(0)).toBe(false);
            expect(isPidRunning(-1)).toBe(false);
            expect(isPidRunning(999999)).toBe(false);
            expect(runner.pid).toBeDefined();
            expect(isPidRunning(runner.pid!)).toBe(true);
        } finally {
            runner.kill("SIGTERM");
            await new Promise((resolve) => runner.once("exit", resolve));
        }
    });

    test("acquireStateAndIdentity exits when a live runner already holds the lock", async () => {
        const statePath = join(tmpHome, ".pizzapi", "runner.json");
        mkdirSync(join(tmpHome, ".pizzapi"), { recursive: true });
        const runner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "runner-lock"]);
        const originalExit = process.exit;

        try {
            writeFileSync(
                statePath,
                JSON.stringify(
                    {
                        pid: runner.pid,
                        startedAt: "2024-01-01T00:00:00.000Z",
                        runnerId: "runner-123",
                        runnerSecret: "secret-abc",
                    },
                    null,
                    2,
                ),
            );

            (process as any).exit = (code?: number) => {
                throw new Error(`process.exit:${code ?? 0}`);
            };

            expect(() => acquireStateAndIdentity(statePath)).toThrow("process.exit:1");
        } finally {
            process.exit = originalExit;
            runner.kill("SIGTERM");
            await new Promise((resolve) => runner.once("exit", resolve));
        }
    });
});
