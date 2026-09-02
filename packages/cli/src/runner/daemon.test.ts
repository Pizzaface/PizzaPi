import { describe, expect, test } from "bun:test";
import { initServiceHandlers } from "./daemon.js";
import type { ServiceHandler, ServiceInitOptions } from "./service-handler.js";
import type { Socket } from "socket.io-client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeSocket(): Socket {
    return {} as Socket;
}

function makeOpts(): ServiceInitOptions {
    return { isShuttingDown: () => false };
}

describe("initServiceHandlers", () => {
    test("initializes all handlers and tracks ids", () => {
        const initialized = new Set<string>();
        const handlers: ServiceHandler[] = [
            { id: "a", init: () => {}, dispose: () => {} },
            { id: "b", init: () => {}, dispose: () => {} },
        ];

        const result = initServiceHandlers(handlers, makeSocket(), makeOpts, initialized);

        expect(result.initialized).toEqual(["a", "b"]);
        expect(result.failed).toEqual([]);
        expect(Array.from(initialized)).toEqual(["a", "b"]);
    });

    test("continues past a throwing handler and retries it on the next call", () => {
        const initialized = new Set<string>();
        const calls: string[] = [];
        let throwCount = 0;
        const handlers: ServiceHandler[] = [
            {
                id: "ok",
                init: () => {
                    calls.push("ok");
                },
                dispose: () => {},
            },
            {
                id: "throws-once",
                init: () => {
                    calls.push("throws-once");
                    if (throwCount++ === 0) {
                        throw new Error("boom");
                    }
                },
                dispose: () => {},
            },
            {
                id: "after",
                init: () => {
                    calls.push("after");
                },
                dispose: () => {},
            },
        ];

        const first = initServiceHandlers(handlers, makeSocket(), makeOpts, initialized);
        expect(first.initialized).toEqual(["ok", "after"]);
        expect(first.failed).toEqual(["throws-once"]);
        expect(calls).toEqual(["ok", "throws-once", "after"]);

        // On a second call, the previously successful handlers are skipped and
        // the failed handler is retried.
        const second = initServiceHandlers(handlers, makeSocket(), makeOpts, initialized);
        expect(second.initialized).toEqual(["throws-once"]);
        expect(second.failed).toEqual([]);
        expect(Array.from(initialized)).toEqual(["ok", "after", "throws-once"]);
    });

    test("skips already-initialized handlers", () => {
        const initialized = new Set<string>(["skip"]);
        let called = false;
        const handlers: ServiceHandler[] = [
            {
                id: "skip",
                init: () => {
                    called = true;
                },
                dispose: () => {},
            },
        ];

        const result = initServiceHandlers(handlers, makeSocket(), makeOpts, initialized);
        expect(result.initialized).toEqual([]);
        expect(called).toBe(false);
    });
});

describe("reapSessionGroups (adopted-session cleanup regression)", () => {
    test("reaps recorded groups and removes proc file for the target session; leaves other sessions untouched", () => {
        const tmpHome = mkdtempSync(join(tmpdir(), "reap-session-test-"));
        const childTestPath = join(
            import.meta.dir,
            `.reap-session-child-${Date.now()}-${Math.random().toString(16).slice(2)}.test.ts`,
        );
        const cliDir = join(import.meta.dir, "../../..");

        try {
            writeFileSync(
                childTestPath,
                `
import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("reapSessionGroups", () => {
    test("reaps target session proc groups and removes proc file; other session untouched", async () => {
        const HOME = process.env.TEST_HOME!;
        const procDir = join(HOME, ".pizzapi", "session-procs");
        mkdirSync(procDir, { recursive: true });

        // Target session proc file with two recorded group PIDs.
        writeFileSync(join(procDir, "target-session.pids"), "11111\\n22222\\n");
        // Another session whose proc file must NOT be removed.
        writeFileSync(join(procDir, "other-session.pids"), "33333\\n");

        const killCalls: number[] = [];
        mock.module("./session-spawner.js", () => ({
            killSessionProcessGroup: (pid: number) => { killCalls.push(pid); return true; },
            spawnSession: () => {},
            notifyWorkersOfRestart: async () => {},
        }));

        const { reapSessionGroups } = await import("./daemon.js");
        reapSessionGroups("target-session");

        // Both recorded group PIDs reaped for the target session.
        expect(killCalls.sort((a, b) => a - b)).toEqual([11111, 22222]);

        // Target proc file removed.
        expect(existsSync(join(procDir, "target-session.pids"))).toBe(false);

        // Other session's proc file untouched.
        expect(existsSync(join(procDir, "other-session.pids"))).toBe(true);
    });
});
`,
            );

            execFileSync(process.execPath, ["test", childTestPath], {
                cwd: cliDir,
                encoding: "utf-8",
                env: { ...process.env, HOME: tmpHome, TEST_HOME: tmpHome },
                stdio: ["ignore", "pipe", "pipe"],
            });

            expect(true).toBe(true); // child exited 0
        } finally {
            rmSync(childTestPath, { force: true });
            rmSync(tmpHome, { recursive: true, force: true });
        }
    });
});
