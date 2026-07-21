import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workflowDirs, listSavedWorkflows, saveWorkflow, loadWorkflow } from "./persistence.js";

/**
 * Persistence tests use mkdtempSync for both cwd (project scope) and a
 * temp-HOME override (user scope) so nothing ever touches the real
 * ~/.pizzapi. HOME is restored in afterEach even on failure.
 */

let projectDir: string;
let fakeHome: string;
let originalHome: string | undefined;

beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "workflow-persist-project-"));
    fakeHome = mkdtempSync(join(tmpdir(), "workflow-persist-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
});

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try {
        rmSync(projectDir, { recursive: true, force: true });
    } catch {}
    try {
        rmSync(fakeHome, { recursive: true, force: true });
    } catch {}
});

describe("workflowDirs", () => {
    test("resolves project dir under cwd and user dir under HOME", () => {
        const dirs = workflowDirs(projectDir);
        expect(dirs.project).toBe(join(projectDir, ".pizzapi", "workflows"));
        expect(dirs.user).toBe(join(fakeHome, ".pizzapi", "workflows"));
    });
});

describe("save / list / load round trip", () => {
    test("saveWorkflow then loadWorkflow returns the same script", () => {
        const script = "return await agent('hi');";
        const filePath = saveWorkflow(projectDir, { name: "greet", script, scope: "project" });
        expect(filePath).toBe(join(projectDir, ".pizzapi", "workflows", "greet.js"));

        const loaded = loadWorkflow(projectDir, "greet");
        expect(loaded).not.toBeNull();
        expect(loaded!.script.trim()).toBe(script);
    });

    test("saveWorkflow persists description in meta, parsed back by list and load", () => {
        saveWorkflow(projectDir, { name: "audit", script: "return 1;", scope: "user", description: "runs an audit" });

        const list = listSavedWorkflows(projectDir);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ name: "audit", scope: "user" });
        expect(list[0].meta?.description).toBe("runs an audit");

        const loaded = loadWorkflow(projectDir, "audit");
        expect(loaded?.meta?.description).toBe("runs an audit");
    });

    test("defaults to project scope when scope is omitted", () => {
        const filePath = saveWorkflow(projectDir, { name: "default-scope", script: "return 1;" });
        expect(filePath).toBe(join(projectDir, ".pizzapi", "workflows", "default-scope.js"));
    });

    test("returns null for an unknown workflow name", () => {
        expect(loadWorkflow(projectDir, "does-not-exist")).toBeNull();
    });

    test("sanitizes unsafe name characters for the filename", () => {
        const filePath = saveWorkflow(projectDir, { name: "../../etc/evil", script: "return 1;", scope: "project" });
        expect(filePath.startsWith(join(projectDir, ".pizzapi", "workflows"))).toBe(true);
        expect(filePath).not.toContain("..");
    });
});

describe("project shadows user on name conflict", () => {
    test("listSavedWorkflows prefers the project-scope entry", () => {
        saveWorkflow(projectDir, { name: "shared", script: "return 'user';", scope: "user", description: "user version" });
        saveWorkflow(projectDir, { name: "shared", script: "return 'project';", scope: "project", description: "project version" });

        const list = listSavedWorkflows(projectDir);
        const entry = list.find((w) => w.name === "shared");
        expect(entry?.scope).toBe("project");
        expect(entry?.meta?.description).toBe("project version");
    });

    test("loadWorkflow prefers the project-scope file", () => {
        saveWorkflow(projectDir, { name: "shared", script: "return 'user';", scope: "user" });
        saveWorkflow(projectDir, { name: "shared", script: "return 'project';", scope: "project" });

        const loaded = loadWorkflow(projectDir, "shared");
        expect(loaded?.script.trim()).toBe("return 'project';");
    });
});

describe("listSavedWorkflows", () => {
    test("returns an empty list when no workflows exist", () => {
        expect(listSavedWorkflows(projectDir)).toEqual([]);
    });

    test("ignores non-.js files and files without a meta block", () => {
        const dir = join(projectDir, ".pizzapi", "workflows");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "notes.txt"), "not a workflow");
        writeFileSync(join(dir, "bare.js"), "return 42;");

        const list = listSavedWorkflows(projectDir);
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe("bare");
        expect(list[0].meta).toBeUndefined();
    });
});
