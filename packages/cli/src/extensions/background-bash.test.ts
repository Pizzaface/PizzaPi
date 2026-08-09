import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundBashExtension, backgroundPendingJobs, pendingCommands, backgroundAfterSeconds, resetBackgroundBashConfigCache } from "./background-bash.js";
import { sessionJobsFilePath } from "../runner/session-procs.js";

// Keep the auto-background window out of the way unless a test opts in, and
// never write to the real session's proc/jobs files (inherited when tests run
// under a PizzaPi worker).
beforeAll(() => {
    process.env.PIZZAPI_BASH_BACKGROUND_SECONDS = "30";
    delete process.env.PIZZAPI_SESSION_PROC_FILE;
});
afterAll(() => { delete process.env.PIZZAPI_BASH_BACKGROUND_SECONDS; });

function mockPi() {
    const messages: any[] = [];
    const tools = new Map<string, any>();
    const shortcuts = new Map<string, any>();
    const commands = new Map<string, any>();
    const handlers = new Map<string, any[]>();
    return {
        messages,
        tools,
        shortcuts,
        commands,
        emit(event: string, payload?: any) { for (const h of handlers.get(event) ?? []) h(payload); },
        registerTool(tool: any) { tools.set(tool.name, tool); },
        registerShortcut(key: string, opts: any) { shortcuts.set(key, opts); },
        registerCommand(name: string, opts: any) { commands.set(name, opts); },
        sendMessage(msg: any, opts: any) { messages.push({ msg, opts }); },
        on(event: string, handler: any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    };
}

function getTool() {
    const pi = mockPi();
    backgroundBashExtension(pi as any);
    return { pi, tool: pi.tools.get("bash")! };
}

const run = (tool: any, params: any) => tool.execute("id", params, undefined, undefined, undefined);

describe("bash override with backgrounding", () => {
    test("overrides the built-in bash tool by name", () => {
        const { pi } = getTool();
        expect(pi.tools.has("bash")).toBe(true);
        expect(pi.tools.get("bash").description).toContain("run_in_background");
        expect(pi.tools.get("bash").parameters.required).toEqual(["command", "title"]);
    });

    test("background threshold: default 5min, env override, invalid falls back", () => {
        const prev = process.env.PIZZAPI_BASH_BACKGROUND_SECONDS;
        delete process.env.PIZZAPI_BASH_BACKGROUND_SECONDS;
        // Reset module cache so config is re-read.
        resetBackgroundBashConfigCache();
        expect(backgroundAfterSeconds()).toBe(300);
        process.env.PIZZAPI_BASH_BACKGROUND_SECONDS = "0";
        expect(backgroundAfterSeconds()).toBe(0);
        process.env.PIZZAPI_BASH_BACKGROUND_SECONDS = "nope";
        expect(backgroundAfterSeconds()).toBe(300);
        process.env.PIZZAPI_BASH_BACKGROUND_SECONDS = prev!;
    });

    test("auto-backgrounds once the foreground window elapses", async () => {
        process.env.PIZZAPI_BASH_BACKGROUND_SECONDS = "0.3";
        try {
            const { pi, tool } = getTool();
            const started = Date.now();
            const res = await run(tool, { command: "sleep 1; echo slow", title: "Slow thing" });
            const elapsed = Date.now() - started;
            expect(elapsed).toBeGreaterThan(250);
            expect(elapsed).toBeLessThan(900);
            expect(res.content[0].text).toContain("Still running");
            expect(res.content[0].text).toContain("Slow thing");
            expect(pi.messages.length).toBe(0);

            await Bun.sleep(1200);
            expect(pi.messages[0].msg.content).toContain("Slow thing exited with code 0");
        } finally {
            process.env.PIZZAPI_BASH_BACKGROUND_SECONDS = "30";
        }
    });

    test("foreground command returns output inline, no notification", async () => {
        const { pi, tool } = getTool();
        const res = await run(tool, { command: "echo hello" });
        expect(res.content[0].text).toContain("hello");
        expect(pi.messages.length).toBe(0);
    });

    test("foreground non-zero exit throws like the built-in", async () => {
        const { tool } = getTool();
        await expect(run(tool, { command: "exit 3" })).rejects.toThrow("exited with code 3");
    });

    test("run_in_background returns immediately and notifies on exit", async () => {
        const { pi, tool } = getTool();
        const started = Date.now();
        const res = await run(tool, { command: "sleep 0.4; exit 7", title: "Late job", run_in_background: true });
        expect(Date.now() - started).toBeLessThan(300);
        expect(res.content[0].text).toContain("Still running");
        expect(pi.messages.length).toBe(0);

        await Bun.sleep(900);
        expect(pi.messages.length).toBe(1);
        expect(pi.messages[0].msg.content).toContain("Late job exited with code 7");
        expect(pi.messages[0].msg.content).toContain("See full stdout/stderr in ");
        expect(pi.messages[0].msg.details.exitCode).toBe(7);
        expect(pi.messages[0].opts.triggerTurn).toBe(true); // idle → must start a turn
    });

    test("a completion stranded in a drained queue is re-sent, then confirmed", async () => {
        const { pi, tool } = getTool();
        pi.emit("agent_start");
        await run(tool, { command: "exit 0", title: "Racy job", run_in_background: true });
        await Bun.sleep(200);
        expect(pi.messages.length).toBe(1);
        expect(pi.messages[0].opts.deliverAs).toBe("steer"); // streaming → interrupt the turn

        // Turn ended without the queued message ever being processed.
        pi.emit("agent_settled");
        expect(pi.messages.length).toBe(2);
        expect(pi.messages[1].opts.triggerTurn).toBe(true);

        // The re-send lands: no further attempts.
        pi.emit("message_start", { message: pi.messages[1].msg });
        pi.emit("agent_settled");
        expect(pi.messages.length).toBe(2);
    });

    test("manual background (TUI shortcut / web exec) detaches a running foreground command", async () => {
        const { pi, tool } = getTool();
        const call = run(tool, { command: "sleep 0.5; echo late" });
        await Bun.sleep(80);
        expect(pendingCommands()).toEqual(["sleep 0.5; echo late"]);
        expect(backgroundPendingJobs().length).toBe(1);

        const res = await call;
        expect(res.content[0].text).toContain("Still running");

        await Bun.sleep(900);
        expect(pi.messages[0].msg.content).toContain("exited with code 0");
    });

    test("bash_output returns only new output since the last call", async () => {
        const { pi, tool } = getTool();
        const res = await run(tool, {
            command: "echo first; sleep 0.4; echo second",
            run_in_background: true,
        });
        const pid = Number(res.content[0].text.match(/pid (\d+)/)![1]);
        const bashOutput = pi.tools.get("bash_output")!;

        await Bun.sleep(150);
        const out1 = await bashOutput.execute("id", { pid });
        expect(out1.content[0].text).toContain("first");
        expect(out1.content[0].text).toContain("running");

        await Bun.sleep(600);
        const out2 = await bashOutput.execute("id", { pid });
        const body2 = out2.content[0].text.split("\n").slice(1).join("\n"); // drop header (echoes the command)
        expect(body2).toContain("second");
        expect(body2).not.toContain("first"); // incremental
        expect(out2.content[0].text).toContain("exited 0");

        const listing = await bashOutput.execute("id", {});
        expect(listing.content[0].text).toContain(`pid ${pid}`);
    });

    test("kill_shell kills the process group and the notification reports it", async () => {
        const { pi, tool } = getTool();
        const res = await run(tool, { command: "sleep 30", run_in_background: true });
        const pid = Number(res.content[0].text.match(/pid (\d+)/)![1]);

        const killShell = pi.tools.get("kill_shell")!;
        const killed = await killShell.execute("id", { pid });
        expect(killed.content[0].text).toContain(`Killed pid ${pid}`);

        await Bun.sleep(300);
        expect(pi.messages.length).toBe(1);
        expect(pi.messages[0].msg.content).toContain("killed by");

        const again = await killShell.execute("id", { pid });
        expect(again.content[0].text).toContain("already");
    });

    test("shortcut, /background, and /shells commands are registered", () => {
        const { pi } = getTool();
        expect(pi.shortcuts.has("ctrl+shift+b")).toBe(true);
        expect(pi.commands.has("background")).toBe(true);
        expect(pi.commands.has("shells")).toBe(true);
    });
});

describe("process tracking and lifecycle", () => {
    function withProcFile(): { dir: string; procFile: string; jobsFile: string; cleanup: () => void } {
        const dir = mkdtempSync(join(tmpdir(), "bgbash-"));
        const procFile = join(dir, "s.pids");
        process.env.PIZZAPI_SESSION_PROC_FILE = procFile;
        return {
            dir,
            procFile,
            jobsFile: sessionJobsFilePath(procFile),
            cleanup: () => {
                delete process.env.PIZZAPI_SESSION_PROC_FILE;
                rmSync(dir, { recursive: true, force: true });
            },
        };
    }

    /** Spawn-and-reap a process to get a pid that is definitely dead. */
    async function deadPid(): Promise<number> {
        const p = spawn("true");
        await new Promise((r) => p.on("close", r));
        return p.pid!;
    }

    test("records the command's group-leader pid into the session proc file", async () => {
        const { procFile, cleanup } = withProcFile();
        try {
            const { tool } = getTool();
            await run(tool, { command: "echo hi", title: "hi" });
            const pids = readFileSync(procFile, "utf8").trim().split("\n").map(Number);
            expect(pids.length).toBe(1);
            expect(pids[0]).toBeGreaterThan(0);
        } finally {
            cleanup();
        }
    });

    test("persists backgrounded jobs and marks their exit", async () => {
        const { jobsFile, cleanup } = withProcFile();
        try {
            const { tool } = getTool();
            const res = await run(tool, { command: "sleep 0.3; exit 5", title: "Flaky", run_in_background: true });
            const pid = Number(res.content[0].text.match(/pid (\d+)/)![1]);

            const persisted = JSON.parse(readFileSync(jobsFile, "utf8"));
            const rec = persisted.find((j: any) => j.pid === pid);
            expect(rec.title).toBe("Flaky");
            expect(rec.endedAt).toBeUndefined();

            await Bun.sleep(800);
            const after = JSON.parse(readFileSync(jobsFile, "utf8")).find((j: any) => j.pid === pid);
            expect(after.exitCode).toBe(5);
            expect(after.endedAt).toBeGreaterThan(0);
        } finally {
            cleanup();
        }
    });

    test("recovers persisted jobs on startup; dead ones marked lost, log still readable", async () => {
        const { dir, jobsFile, cleanup } = withProcFile();
        try {
            const pid = await deadPid();
            const logPath = join(dir, "dev.log");
            writeFileSync(logPath, "old output here");
            writeFileSync(
                jobsFile,
                JSON.stringify([{ pid, command: "npm run dev", title: "Dev server", logPath, startedAt: Date.now() - 5000, readOffset: 0 }]),
            );

            const { pi } = getTool(); // factory runs loadJobs()
            const bashOutput = pi.tools.get("bash_output")!;
            const listing = await bashOutput.execute("id", {});
            expect(listing.content[0].text).toContain("npm run dev");
            expect(listing.content[0].text).toContain("lost to a worker restart");

            const out = await bashOutput.execute("id", { pid });
            expect(out.content[0].text).toContain("old output here");
        } finally {
            cleanup();
        }
    });

    test("/new reset kills running shells, silences completions, removes logs", async () => {
        const { pi, tool } = getTool();
        const res = await run(tool, { command: "sleep 30", title: "Server", run_in_background: true });
        const pid = Number(res.content[0].text.match(/pid (\d+)/)![1]);
        const logPath = res.content[0].text.match(/goes to (\S+)\./)![1];

        pi.emit("session_switch", { reason: "new" });

        const listing = await pi.tools.get("bash_output")!.execute("id", {});
        expect(listing.content[0].text).toBe("No background shells.");
        expect(existsSync(logPath)).toBe(false);

        await Bun.sleep(300);
        expect(pi.messages.length).toBe(0); // completion suppressed — old conversation is gone
        expect(() => process.kill(pid, 0)).toThrow(); // actually dead
    });

    test("session_shutdown kills running shells without notifying", async () => {
        const { pi, tool } = getTool();
        const res = await run(tool, { command: "sleep 30", title: "Server", run_in_background: true });
        const pid = Number(res.content[0].text.match(/pid (\d+)/)![1]);

        pi.emit("session_shutdown");

        await Bun.sleep(300);
        expect(pi.messages.length).toBe(0);
        expect(() => process.kill(pid, 0)).toThrow();
    });
});
