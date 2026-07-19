import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePsLine, ProcessService } from "./process-service.js";
import { killSessionProcessGroup } from "../session-spawner.js";

describe("parsePsLine", () => {
    test("parses a normal ps line", () => {
        expect(parsePsLine("  1234 02:13  51200 bun run dev --port 3000")).toEqual({
            pid: 1234,
            etime: "02:13",
            rssKb: 51200,
            command: "bun run dev --port 3000",
        });
    });

    test("parses day-form etime", () => {
        expect(parsePsLine("99999 1-04:00:00 8 node server.js")?.etime).toBe("1-04:00:00");
    });

    test("rejects garbage", () => {
        expect(parsePsLine("")).toBeNull();
        expect(parsePsLine("not a ps line")).toBeNull();
    });
});

describe("killSessionProcessGroup", () => {
    test("returns false for undefined or dead pid", () => {
        expect(killSessionProcessGroup(undefined)).toBe(false);
        // PID unlikely to be a live process group
        expect(killSessionProcessGroup(2 ** 21)).toBe(false);
    });

    test("kills a detached process group including grandchildren", async () => {
        // sh spawns a background sleep (grandchild), then sleeps itself
        const child = spawn("sh", ["-c", "sleep 30 & sleep 30"], { detached: true, stdio: "ignore" });
        const pid = child.pid!;
        await new Promise((r) => setTimeout(r, 100));
        expect(killSessionProcessGroup(pid, "SIGKILL")).toBe(true);
        await new Promise((r) => setTimeout(r, 100));
        // Signaling again should fail — the whole group is gone
        expect(killSessionProcessGroup(pid, "SIGKILL")).toBe(false);
    });
});

describe("ProcessService", () => {
    test("lists processes for a live group and refuses foreign pids", async () => {
        const child = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
        const pid = child.pid!;
        await new Promise((r) => setTimeout(r, 100));

        const service = new ProcessService((sessionId) => (sessionId === "s1" ? pid : null));
        const sent: Array<{ type: string; payload: any }> = [];
        const socket = {
            on: () => {},
            off: () => {},
            emit: (_event: string, envelope: any) => sent.push(envelope),
        };
        (service as any).socket = socket;

        await (service as any).handleList({ serviceId: "process", type: "process_list", sessionId: "s1", payload: {} });
        expect(sent[0].type).toBe("process_list_result");
        expect(sent[0].payload.workerPid).toBe(pid);
        expect(sent[0].payload.processes.some((p: any) => p.pid === pid)).toBe(true);

        // Kill request for a pid outside the group is rejected
        await (service as any).handleKill({ serviceId: "process", type: "process_kill", sessionId: "s1", payload: { pid: process.pid } });
        expect(sent[1].type).toBe("process_error");

        // Killing the worker pid itself is refused
        await (service as any).handleKill({ serviceId: "process", type: "process_kill", sessionId: "s1", payload: { pid } });
        expect(sent[2].type).toBe("process_error");

        killSessionProcessGroup(pid, "SIGKILL");
    });

    test("lists a recorded background group even with no worker pid", async () => {
        // Simulate a backgrounded command whose bash wrapper exited: the group
        // leader PID was recorded to the pid file, and a detached grandchild is
        // still alive in that group.
        const child = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
        const groupPid = child.pid!;
        await new Promise((r) => setTimeout(r, 100));

        const dir = mkdtempSync(join(tmpdir(), "procsvc-"));
        const procFile = join(dir, "s2.pids");
        writeFileSync(procFile, `${groupPid}\n`);

        // No worker pid (adopted/ended session) — only the recorded group.
        const service = new ProcessService(() => null, () => procFile);
        const sent: Array<{ type: string; payload: any }> = [];
        (service as any).socket = { on() {}, off() {}, emit: (_e: string, env: any) => sent.push(env) };

        await (service as any).handleList({ serviceId: "process", type: "process_list", sessionId: "s2", payload: {} });
        expect(sent[0].type).toBe("process_list_result");
        expect(sent[0].payload.workerPid).toBeNull();
        expect(sent[0].payload.processes.some((p: any) => p.pid === groupPid)).toBe(true);

        // A member of the recorded group can be killed (authorized).
        await (service as any).handleKill({ serviceId: "process", type: "process_kill", sessionId: "s2", payload: { pid: groupPid } });
        expect(sent[1].type).toBe("process_list_result");

        killSessionProcessGroup(groupPid, "SIGKILL");
        rmSync(dir, { recursive: true, force: true });
    });
});
