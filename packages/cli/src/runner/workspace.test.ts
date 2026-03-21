import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkspaceRoots, isCwdAllowed } from "./workspace.js";

describe("workspace guards", () => {
    const envKeys = [
        "PIZZAPI_WORKSPACE_ROOTS",
        "PIZZAPI_WORKSPACE_ROOT",
        "PIZZAPI_RUNNER_ROOTS",
    ] as const;

    let originalEnv: Record<string, string | undefined>;
    let tmpRoot: string;

    beforeEach(() => {
        originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
        for (const key of envKeys) delete process.env[key];
        tmpRoot = mkdtempSync(join(tmpdir(), "workspace-test-"));
    });

    afterEach(() => {
        for (const key of envKeys) {
            const value = originalEnv[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(tmpRoot, { recursive: true, force: true });
    });

    test("prefers explicit workspace roots env and normalizes separators", () => {
        process.env.PIZZAPI_WORKSPACE_ROOTS = " /tmp/one//, C:\\work\\two\\ ";
        process.env.PIZZAPI_WORKSPACE_ROOT = "/tmp/ignored";
        process.env.PIZZAPI_RUNNER_ROOTS = "/tmp/legacy";

        expect(getWorkspaceRoots()).toEqual(["/tmp/one", "C:/work/two"]);
    });

    test("allows any cwd when no workspace roots are configured", () => {
        expect(isCwdAllowed(join(tmpRoot, "anywhere"))).toBe(true);
        expect(isCwdAllowed(undefined)).toBe(true);
    });

    test("rejects paths that escape the allowed root via .. traversal", () => {
        const root = join(tmpRoot, "allowed");
        const outside = join(tmpRoot, "outside");
        const project = join(root, "project");
        mkdirSync(root, { recursive: true });
        mkdirSync(project, { recursive: true });
        mkdirSync(outside, { recursive: true });
        process.env.PIZZAPI_WORKSPACE_ROOT = root;

        expect(isCwdAllowed(project)).toBe(true);
        expect(isCwdAllowed(join(root, "..", "outside"))).toBe(false);
    });

    test("rejects symlinked paths that resolve outside the allowed root", () => {
        const root = join(tmpRoot, "allowed");
        const outside = join(tmpRoot, "outside");
        mkdirSync(root, { recursive: true });
        mkdirSync(outside, { recursive: true });
        symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
        process.env.PIZZAPI_WORKSPACE_ROOT = root;

        expect(isCwdAllowed(join(root, "escape"))).toBe(false);
    });
});
