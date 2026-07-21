import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workflowExtension } from "./index.js";
import { saveWorkflow, loadWorkflow, workflowTemplate } from "./persistence.js";

/**
 * index.ts tool-surface tests, focused on error-shape correctness: a
 * successful workflow run whose requested `save` fails must come back as a
 * structured error result (not a "done" status with a text footnote), and
 * fs errors from list/load (now rethrown by persistence.ts for anything
 * but ENOENT) must be caught here, not thrown across the tool boundary.
 */

interface RegisteredTool {
    name: string;
    execute: (...args: any[]) => Promise<any>;
}

interface RegisteredCommand {
    description?: string;
    getArgumentCompletions?: (prefix: string) => any;
    handler: (args: string, ctx: any) => Promise<void>;
}

function createMockPi() {
    const tools = new Map<string, RegisteredTool>();
    const commands = new Map<string, RegisteredCommand>();
    return {
        tools,
        commands,
        registerTool(tool: any) {
            tools.set(tool.name, tool);
        },
        registerCommand(name: string, options: RegisteredCommand) {
            commands.set(name, options);
        },
    };
}

function createNotifyCtx(cwd: string, signal?: AbortSignal) {
    const notifications: Array<{ message: string; type?: string }> = [];
    return {
        notifications,
        ctx: {
            cwd,
            signal,
            modelRegistry: undefined,
            ui: {
                notify: (message: string, type?: string) => notifications.push({ message, type }),
            },
        },
    };
}

let projectDir: string;

beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "workflow-index-test-"));
});

afterEach(() => {
    try {
        rmSync(projectDir, { recursive: true, force: true });
    } catch {}
});

function extractText(result: any): string {
    return result?.content?.[0]?.text ?? "";
}

describe("run_workflow — save failure after a successful run", () => {
    test("returns a structured status:error result with isError:true, not a 'done' status with a text warning", async () => {
        const pi = createMockPi();
        workflowExtension(pi as any);
        const tool = pi.tools.get("run_workflow")!;

        // Force the save to fail: make the workflows dir path collide with a
        // regular file, so mkdirSync inside saveWorkflow throws (ENOTDIR).
        const workflowsParentAsFile = join(projectDir, ".pizzapi");
        mkdirSync(workflowsParentAsFile, { recursive: true });
        writeFileSync(join(workflowsParentAsFile, "workflows"), "not a directory");

        const result = await tool.execute(
            "call-1",
            { script: "return 'ok';", save: { name: "will-fail", scope: "project" } },
            undefined,
            undefined,
            { cwd: projectDir },
        );

        expect(result.isError).toBe(true);
        expect(result.details.status).toBe("error");
        expect(result.details.error).toContain("failed to save");
        expect(extractText(result)).toContain("Failed to save workflow");
        // The workflow's own successful result is still visible in the text.
        expect(extractText(result)).toContain("ok");
    });

    test("does not mark the result as an error when there is no save request", async () => {
        const pi = createMockPi();
        workflowExtension(pi as any);
        const tool = pi.tools.get("run_workflow")!;

        const result = await tool.execute("call-1", { script: "return 'ok';" }, undefined, undefined, { cwd: projectDir });

        expect(result.isError).toBeUndefined();
        expect(result.details.status).toBe("done");
        expect(extractText(result)).toBe("ok");
    });
});

describe("/workflow command — listing", () => {
    test("no saved workflows: reports the empty state", async () => {
        const pi = createMockPi();
        workflowExtension(pi as any);
        const cmd = pi.commands.get("workflow")!;
        const { ctx, notifications } = createNotifyCtx(projectDir);

        await cmd.handler("", ctx);

        expect(notifications).toHaveLength(1);
        expect(notifications[0].message).toContain("No saved workflows");
        expect(notifications[0].type).toBeUndefined();
    });

    test("with saved workflows: lists name, scope, and description", async () => {
        const pi = createMockPi();
        workflowExtension(pi as any);
        const runTool = pi.tools.get("run_workflow")!;
        await runTool.execute(
            "call-1",
            { script: "return 'ok';", save: { name: "my-flow", scope: "project" } },
            undefined,
            undefined,
            { cwd: projectDir },
        );

        const cmd = pi.commands.get("workflow")!;
        const { ctx, notifications } = createNotifyCtx(projectDir);
        await cmd.handler("  ", ctx);

        expect(notifications).toHaveLength(1);
        expect(notifications[0].message).toContain("my-flow (project)");
    });
});

describe("/workflow command — running", () => {
    test("runs a saved workflow by name and notifies the result", async () => {
        const pi = createMockPi();
        workflowExtension(pi as any);
        const runTool = pi.tools.get("run_workflow")!;
        await runTool.execute(
            "call-1",
            { script: "return 'hello ' + (args?.who ?? 'world');", save: { name: "greet" } },
            undefined,
            undefined,
            { cwd: projectDir },
        );

        const cmd = pi.commands.get("workflow")!;
        const { ctx, notifications } = createNotifyCtx(projectDir);
        await cmd.handler("greet", ctx);

        expect(notifications.length).toBeGreaterThanOrEqual(2);
        expect(notifications[0].message).toContain('Running workflow "greet"');
        expect(notifications.at(-1)!.message).toBe("hello world");
        expect(notifications.at(-1)!.type).toBe("info");
    });

    test("passes trailing JSON as args to the saved workflow", async () => {
        const pi = createMockPi();
        workflowExtension(pi as any);
        // args is undefined on this first (unsaved-until-successful) run, so
        // the script must tolerate a missing args to actually reach "done"
        // and get persisted.
        const runTool = pi.tools.get("run_workflow")!;
        await runTool.execute(
            "call-1",
            { script: "return 'hello ' + (args?.who ?? 'world');", save: { name: "greet" } },
            undefined,
            undefined,
            { cwd: projectDir },
        );

        const cmd = pi.commands.get("workflow")!;
        const { ctx, notifications } = createNotifyCtx(projectDir);
        await cmd.handler('greet {"who":"Ada"}', ctx);

        expect(notifications.at(-1)!.message).toBe("hello Ada");
    });

    test("invalid trailing JSON reports an error instead of running", async () => {
        const pi = createMockPi();
        workflowExtension(pi as any);
        const runTool = pi.tools.get("run_workflow")!;
        await runTool.execute("call-1", { script: "return 'x';", save: { name: "greet" } }, undefined, undefined, { cwd: projectDir });

        const cmd = pi.commands.get("workflow")!;
        const { ctx, notifications } = createNotifyCtx(projectDir);
        await cmd.handler("greet {not json", ctx);

        expect(notifications).toHaveLength(1);
        expect(notifications[0].type).toBe("error");
        expect(notifications[0].message).toContain("Invalid JSON args");
    });

    test("unknown workflow name reports an error", async () => {
        const pi = createMockPi();
        workflowExtension(pi as any);
        const cmd = pi.commands.get("workflow")!;
        const { ctx, notifications } = createNotifyCtx(projectDir);

        await cmd.handler("nope", ctx);

        expect(notifications).toHaveLength(1);
        expect(notifications[0].type).toBe("error");
        expect(notifications[0].message).toContain('No saved workflow named "nope"');
    });

    test("a failing workflow notifies as an error", async () => {
        const pi = createMockPi();
        workflowExtension(pi as any);
        // A script that always throws can never reach run_workflow's
        // save-after-success path, so write it directly to disk instead.
        saveWorkflow(projectDir, { name: "broken", script: "throw new Error('boom');" });

        const cmd = pi.commands.get("workflow")!;
        const { ctx, notifications } = createNotifyCtx(projectDir);
        await cmd.handler("broken", ctx);

        const last = notifications.at(-1)!;
        expect(last.type).toBe("error");
        expect(last.message).toContain("boom");
    });
});

describe("/workflow command — new", () => {
    test("scaffolds a template and reports the path", async () => {
        const pi = createMockPi();
        workflowExtension(pi as any);
        const cmd = pi.commands.get("workflow")!;
        const { ctx, notifications } = createNotifyCtx(projectDir);

        await cmd.handler("new my-flow", ctx);

        expect(notifications).toHaveLength(1);
        expect(notifications[0].type).toBeUndefined();
        expect(notifications[0].message).toContain("Created");
        expect(notifications[0].message).toContain("my-flow");

        // loadWorkflow trims the round-tripped script (via extractMeta), so
        // compare against the same trimmed form rather than the raw template.
        const loaded = loadWorkflow(projectDir, "my-flow");
        expect(loaded?.script).toBe(workflowTemplate().trim());
    });

    test("refuses to overwrite an existing workflow", async () => {
        const pi = createMockPi();
        workflowExtension(pi as any);
        saveWorkflow(projectDir, { name: "taken", script: "return 1;" });

        const cmd = pi.commands.get("workflow")!;
        const { ctx, notifications } = createNotifyCtx(projectDir);
        await cmd.handler("new taken", ctx);

        expect(notifications).toHaveLength(1);
        expect(notifications[0].type).toBe("error");
        expect(notifications[0].message).toContain("already exists");
        // Original script must be untouched.
        expect(loadWorkflow(projectDir, "taken")?.script).toBe("return 1;");
    });

    test("requires a name", async () => {
        const pi = createMockPi();
        workflowExtension(pi as any);
        const cmd = pi.commands.get("workflow")!;
        const { ctx, notifications } = createNotifyCtx(projectDir);

        await cmd.handler("new", ctx);

        expect(notifications).toHaveLength(1);
        expect(notifications[0].type).toBe("error");
        expect(notifications[0].message).toContain("Usage: /workflow new");
    });
});

describe("/workflow command — argument completions", () => {
    test("completes saved workflow names by prefix", async () => {
        const pi = createMockPi();
        workflowExtension(pi as any);
        const runTool = pi.tools.get("run_workflow")!;
        await runTool.execute("call-1", { script: "return 'a';", save: { name: "alpha" } }, undefined, undefined, { cwd: projectDir });
        await runTool.execute("call-2", { script: "return 'b';", save: { name: "beta" } }, undefined, undefined, { cwd: projectDir });

        const cmd = pi.commands.get("workflow")!;
        const originalCwd = process.cwd();
        process.chdir(projectDir);
        try {
            const completions = cmd.getArgumentCompletions!("al");
            expect(completions).toEqual([{ value: "alpha", label: "alpha" }]);

            const withSpace = cmd.getArgumentCompletions!("alpha ");
            expect(withSpace).toBeNull();

            // "new" is always offered alongside saved workflow names.
            const empty = cmd.getArgumentCompletions!("");
            expect(empty).toEqual([
                { value: "new", label: "new" },
                { value: "alpha", label: "alpha" },
                { value: "beta", label: "beta" },
            ]);
        } finally {
            process.chdir(originalCwd);
        }
    });
});

describe("list_workflows — fs error surfacing", () => {
    test("a non-ENOENT fs error from listSavedWorkflows is returned as a structured error, not thrown", async () => {
        const pi = createMockPi();
        workflowExtension(pi as any);
        const tool = pi.tools.get("list_workflows")!;

        // Same ENOTDIR trick: readdirSync on a path that's actually a file.
        const dir = join(projectDir, ".pizzapi");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "workflows"), "not a directory");

        const result = await tool.execute("call-1", { scope: "project" }, undefined, undefined, { cwd: projectDir });

        expect(result.isError).toBe(true);
        expect(result.details.status).toBe("error");
        expect(extractText(result)).toContain("Failed to list workflows");
    });

    test("a missing workflows dir is an empty list, not an error", async () => {
        const pi = createMockPi();
        workflowExtension(pi as any);
        const tool = pi.tools.get("list_workflows")!;

        const result = await tool.execute("call-1", {}, undefined, undefined, { cwd: projectDir });

        expect(result.isError).toBeUndefined();
        expect(extractText(result)).toBe("No saved workflows.");
    });
});
