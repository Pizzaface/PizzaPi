import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readdirSync } from "node:fs";
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

    test("scope:'user' is not hidden by a same-named project workflow (filters before shadowing)", () => {
        saveWorkflow(projectDir, { name: "shared", script: "return 'user';", scope: "user", description: "user version" });
        saveWorkflow(projectDir, { name: "shared", script: "return 'project';", scope: "project", description: "project version" });

        // "both" (default) shadows: only the project entry survives.
        const both = listSavedWorkflows(projectDir);
        expect(both.find((w) => w.name === "shared")?.scope).toBe("project");

        // Explicitly asking for scope:"user" must still surface the user entry,
        // not silently drop it because a project workflow shadows it in "both".
        const userOnly = listSavedWorkflows(projectDir, "user");
        expect(userOnly).toHaveLength(1);
        expect(userOnly[0]).toMatchObject({ name: "shared", scope: "user" });
        expect(userOnly[0].meta?.description).toBe("user version");

        const projectOnly = listSavedWorkflows(projectDir, "project");
        expect(projectOnly).toHaveLength(1);
        expect(projectOnly[0]).toMatchObject({ name: "shared", scope: "project" });
    });
});

describe("listSavedWorkflows — metadata parsing is not code execution (RCE guard)", () => {
    test("a malicious meta block does not execute during listSavedWorkflows", () => {
        const dir = join(projectDir, ".pizzapi", "workflows");
        mkdirSync(dir, { recursive: true });
        // Old implementation used `new Function(...)`/eval to parse this —
        // merely listing workflows would have executed the IIFE below.
        const marker = "__WORKFLOW_META_RCE_MARKER__";
        const malicious = [
            `export const meta = (function() { globalThis.${marker} = true; return { name: "evil" }; })();`,
            "",
            "return 1;",
        ].join("\n");
        writeFileSync(join(dir, "evil.js"), malicious);

        const list = listSavedWorkflows(projectDir);

        expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe("evil");
        // Not a JSON object literal, so parsing fails safely and meta is absent.
        expect(list[0].meta).toBeUndefined();
    });

    test("a getter-based meta block does not execute during listSavedWorkflows", () => {
        const dir = join(projectDir, ".pizzapi", "workflows");
        mkdirSync(dir, { recursive: true });
        const marker = "__WORKFLOW_META_GETTER_MARKER__";
        const malicious = `export const meta = { name: "x", get description() { globalThis.${marker} = true; return "y"; } };\n\nreturn 1;`;
        writeFileSync(join(dir, "evil2.js"), malicious);

        const list = listSavedWorkflows(projectDir);

        expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
        expect(list.find((w) => w.name === "evil2")?.meta).toBeUndefined();
    });
});

describe("saveWorkflow — symlink guard", () => {
    test("refuses to write when the workflows dir is a symlink to outside the project", () => {
        const outside = mkdtempSync(join(tmpdir(), "workflow-outside-"));
        mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
        symlinkSync(outside, join(projectDir, ".pizzapi", "workflows"));

        expect(() => saveWorkflow(projectDir, { name: "pwn", script: "return 1;", scope: "project" })).toThrow(/symlink/i);

        try {
            rmSync(outside, { recursive: true, force: true });
        } catch {}
    });

    test("refuses to overwrite an existing file that is a symlink to outside the project", () => {
        const outsideFile = join(mkdtempSync(join(tmpdir(), "workflow-outside-file-")), "secret.txt");
        writeFileSync(outsideFile, "do not touch me");
        const dir = join(projectDir, ".pizzapi", "workflows");
        mkdirSync(dir, { recursive: true });
        symlinkSync(outsideFile, join(dir, "pwn.js"));

        expect(() => saveWorkflow(projectDir, { name: "pwn", script: "return 1;", scope: "project" })).toThrow(/symlink/i);
    });

    test("path traversal in the name can never escape the workflows dir", () => {
        const workflowsDir = join(projectDir, ".pizzapi", "workflows");
        for (const evilName of ["../../etc/evil", "..", "../../../../../../tmp/evil", "a/../../b"]) {
            const filePath = saveWorkflow(projectDir, { name: evilName, script: "return 1;", scope: "project" });
            // Must land directly inside the workflows dir as a single filename
            // segment — never escape it, regardless of how the sanitized name
            // happens to render (a literal ".." substring in a filename like
            // "a-..-..-b.js" is harmless; a path separator is not).
            expect(filePath.startsWith(workflowsDir + "/")).toBe(true);
            expect(filePath.slice(workflowsDir.length + 1)).not.toContain("/");
        }
    });
});

describe("saveWorkflow — atomic write", () => {
    test("leaves no leftover temp file behind after a successful save", () => {
        saveWorkflow(projectDir, { name: "atomic", script: "return 1;", scope: "project" });
        const dir = join(projectDir, ".pizzapi", "workflows");
        expect(readdirSync(dir)).toEqual(["atomic.js"]);
    });

    test("cleans up its temp file and propagates the error when the rename fails", () => {
        const renameSpy = spyOn(fs, "renameSync").mockImplementation(() => {
            throw new Error("disk exploded");
        });
        try {
            expect(() => saveWorkflow(projectDir, { name: "boom", script: "return 1;", scope: "project" })).toThrow("disk exploded");
        } finally {
            renameSpy.mockRestore();
        }
        const dir = join(projectDir, ".pizzapi", "workflows");
        // No leftover temp file, and the real target was never created.
        expect(readdirSync(dir)).toEqual([]);
    });
});

describe("listSavedWorkflows — fs error surfacing", () => {
    test("an unreadable-dir error (not ENOENT) is rethrown, not swallowed as an empty list", () => {
        mkdirSync(join(projectDir, ".pizzapi", "workflows"), { recursive: true });
        const readdirSpy = spyOn(fs, "readdirSync").mockImplementation(() => {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        });
        try {
            expect(() => listSavedWorkflows(projectDir)).toThrow("permission denied");
        } finally {
            readdirSpy.mockRestore();
        }
    });

    test("a missing (ENOENT) workflows dir is still treated as empty, not an error", () => {
        expect(listSavedWorkflows(projectDir)).toEqual([]);
    });
});
