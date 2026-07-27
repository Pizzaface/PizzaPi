import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { backgroundBashExtension, backgroundPendingJobs, pendingCommands, backgroundAfterSeconds } from "./background-bash.js";

// Keep the auto-background window out of the way unless a test opts in.
beforeAll(() => { process.env.PIZZAPI_BASH_BACKGROUND_SECONDS = "30"; });
afterAll(() => { delete process.env.PIZZAPI_BASH_BACKGROUND_SECONDS; });

function mockPi() {
    const messages: any[] = [];
    const tools = new Map<string, any>();
    const shortcuts = new Map<string, any>();
    const commands = new Map<string, any>();
    return {
        messages,
        tools,
        shortcuts,
        commands,
        registerTool(tool: any) { tools.set(tool.name, tool); },
        registerShortcut(key: string, opts: any) { shortcuts.set(key, opts); },
        registerCommand(name: string, opts: any) { commands.set(name, opts); },
        sendMessage(msg: any, opts: any) { messages.push({ msg, opts }); },
        on: () => {},
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

    test("background threshold: default 15s, env override, invalid falls back", () => {
        const prev = process.env.PIZZAPI_BASH_BACKGROUND_SECONDS;
        delete process.env.PIZZAPI_BASH_BACKGROUND_SECONDS;
        expect(backgroundAfterSeconds()).toBe(15);
        process.env.PIZZAPI_BASH_BACKGROUND_SECONDS = "0";
        expect(backgroundAfterSeconds()).toBe(0);
        process.env.PIZZAPI_BASH_BACKGROUND_SECONDS = "nope";
        expect(backgroundAfterSeconds()).toBe(15);
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
        expect(pi.messages[0].opts.deliverAs).toBe("followUp");
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

    test("shortcut and /background command are registered", () => {
        const { pi } = getTool();
        expect(pi.shortcuts.has("ctrl+shift+b")).toBe(true);
        expect(pi.commands.has("background")).toBe(true);
    });
});
