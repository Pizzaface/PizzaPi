import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workflowExtension } from "./index.js";

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

function createMockPi() {
    const tools = new Map<string, RegisteredTool>();
    return {
        tools,
        registerTool(tool: any) {
            tools.set(tool.name, tool);
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
