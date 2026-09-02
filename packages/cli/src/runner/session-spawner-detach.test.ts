import { describe, expect, test, spyOn } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { notifyWorkersOfRestart, killSessionProcessGroup, type RunnerSession } from "./session-spawner.js";

function session(id: string, child: { connected: boolean; send: (...args: any[]) => boolean } | null): RunnerSession {
    return { sessionId: id, child: child as unknown as ChildProcess | null, startedAt: 0 };
}

describe("notifyWorkersOfRestart", () => {
    test("sends detach only to connected children and waits for the flush", async () => {
        const sent: unknown[] = [];
        const connected = {
            connected: true,
            send: (msg: unknown, cb: () => void) => { sent.push(msg); setTimeout(cb, 5); return true; },
        };
        const map = new Map<string, RunnerSession>([
            ["a", session("a", connected)],
            ["b", session("b", { connected: false, send: () => { throw new Error("should not send"); } })],
            ["c", session("c", null)], // adopted session, no handle
        ]);

        await notifyWorkersOfRestart(map);

        expect(sent).toEqual([{ type: "detach" }]);
    });

    test("does not hang when a child never acknowledges", async () => {
        const map = new Map<string, RunnerSession>([
            ["a", session("a", { connected: true, send: () => true })], // callback never fires
        ]);

        const start = Date.now();
        await notifyWorkersOfRestart(map, 50);
        expect(Date.now() - start).toBeLessThan(1_000);
    });

    test("survives a child that throws on send", async () => {
        const map = new Map<string, RunnerSession>([
            ["a", session("a", { connected: true, send: () => { throw new Error("EPIPE"); } })],
        ]);
        await notifyWorkersOfRestart(map, 50);
    });
});

describe("killSessionProcessGroup — pid validation", () => {
    test("rejects invalid pids without calling process.kill", () => {
        const spy = spyOn(process, "kill").mockImplementation(() => true);
        try {
            for (const bad of [0, -1, -999, NaN, Infinity, -Infinity, 1.5, undefined]) {
                const result = killSessionProcessGroup(bad as unknown as number);
                expect(result).toBe(false);
            }
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    test("calls process.kill(-pid) for a valid positive integer pid", () => {
        const spy = spyOn(process, "kill").mockImplementation(() => true);
        try {
            const result = killSessionProcessGroup(12345, "SIGTERM");
            expect(result).toBe(true);
            expect(spy).toHaveBeenCalledWith(-12345, "SIGTERM");
        } finally {
            spy.mockRestore();
        }
    });
});
