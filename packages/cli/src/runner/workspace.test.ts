import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeProspectivePath, getWorkspaceRoots, isCwdAllowed } from "./workspace.js";

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

    describe("prospective (non-existent) paths", () => {
        const symlinkType = process.platform === "win32" ? "junction" : "dir";
        let root: string;
        let outside: string;

        beforeEach(() => {
            root = join(tmpRoot, "allowed");
            outside = join(tmpRoot, "outside");
            mkdirSync(join(root, "repo"), { recursive: true });
            mkdirSync(outside, { recursive: true });
            process.env.PIZZAPI_WORKSPACE_ROOT = root;
        });

        test("allows a missing path under a real in-root directory", () => {
            expect(isCwdAllowed(join(root, "repo", ".worktrees", "new"))).toBe(true);
            expect(canonicalizeProspectivePath(join(root, "repo", "a", "b"))).toBe(
                join(realpathSync(root), "repo", "a", "b"),
            );
        });

        test("rejects a missing path whose existing parent is a symlink outside the root", () => {
            symlinkSync(outside, join(root, "repo", "link"), symlinkType);
            expect(isCwdAllowed(join(root, "repo", "link", "wt"))).toBe(false);
            expect(isCwdAllowed(join(root, "repo", "link", "deeper", "wt"))).toBe(false);
        });

        test("rejects multi-hop ancestor symlink chains that leave the root", () => {
            const hop2 = join(tmpRoot, "hop2");
            symlinkSync(outside, hop2, symlinkType);
            symlinkSync(hop2, join(root, "repo", "hop1"), symlinkType);
            expect(isCwdAllowed(join(root, "repo", "hop1", "wt"))).toBe(false);
        });

        test("allows in-root symlinked parents", () => {
            mkdirSync(join(root, "real"), { recursive: true });
            symlinkSync(join(root, "real"), join(root, "repo", "inroot"), symlinkType);
            expect(isCwdAllowed(join(root, "repo", "inroot", "wt"))).toBe(true);
        });

        test("rejects paths through a dangling symlink (fail closed)", () => {
            symlinkSync(join(outside, "does-not-exist-yet"), join(root, "repo", "dangling"), symlinkType);
            expect(canonicalizeProspectivePath(join(root, "repo", "dangling", "wt"))).toBeNull();
            expect(isCwdAllowed(join(root, "repo", "dangling", "wt"))).toBe(false);
            expect(isCwdAllowed(join(root, "repo", "dangling"))).toBe(false);
        });

        test("applies .. after a symlink to the resolved target, like the kernel", () => {
            // root/repo/link -> outside/inner ; root/repo/link/../wt is outside/wt
            mkdirSync(join(outside, "inner"), { recursive: true });
            symlinkSync(join(outside, "inner"), join(root, "repo", "link"), symlinkType);
            expect(isCwdAllowed(join(root, "repo", "link") + "/../wt")).toBe(false);
        });
    });
});
