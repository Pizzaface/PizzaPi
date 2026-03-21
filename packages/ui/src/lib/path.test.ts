import { describe, expect, test } from "bun:test";
import { extractWorktreeName, formatPathTail, worktreeRoots } from "./path";

describe("formatPathTail", () => {
    test("returns empty string for empty input", () => {
        expect(formatPathTail("")).toBe("");
    });

    test("returns full path for single segment", () => {
        expect(formatPathTail("/home")).toBe("/home");
    });

    test("shows last 2 segments by default", () => {
        expect(formatPathTail("/home/user/projects/app")).toBe("/…/projects/app");
    });

    test("respects maxSegments parameter", () => {
        expect(formatPathTail("/a/b/c/d", 3)).toBe("/…/b/c/d");
        expect(formatPathTail("/a/b/c/d", 1)).toBe("/…/d");
    });

    test("handles Windows drive letters", () => {
        expect(formatPathTail("C:/Users/me/code/project")).toBe("C:/…/code/project");
    });

    test("handles backslashes (Windows paths)", () => {
        expect(formatPathTail("C:\\Users\\me\\code\\project")).toBe("C:/…/code/project");
    });

    test("handles two-segment paths", () => {
        // segmentsToShow = min(maxSegments, max(1, parts.length - 1))
        // With 2 parts, always shows 1 tail segment regardless of maxSegments
        expect(formatPathTail("/home/user")).toBe("/…/user");
        expect(formatPathTail("/home/user", 3)).toBe("/…/user");
    });

    test("handles root path", () => {
        expect(formatPathTail("/")).toBe("/");
    });

    test("handles relative paths", () => {
        expect(formatPathTail("a/b/c/d")).toBe("…/c/d");
    });
});

describe("extractWorktreeName", () => {
    test("returns null for paths without .worktrees marker", () => {
        expect(extractWorktreeName("/projects/foo/src")).toBeNull();
        expect(extractWorktreeName("")).toBeNull();
    });

    test("extracts single-segment branch name", () => {
        expect(extractWorktreeName("/repo/.worktrees/fix-bar")).toBe("fix-bar");
    });

    test("extracts single-segment branch when cwd is a subdir", () => {
        expect(extractWorktreeName("/repo/.worktrees/fix-bar/src")).toBe("fix-bar");
    });

    test("extracts slashed branch name using known cwds", () => {
        const known = ["/repo/.worktrees/feat/login"];
        expect(extractWorktreeName("/repo/.worktrees/feat/login", known)).toBe("feat/login");
    });

    test("extracts slashed branch name when cwd is a subdir using known cwds", () => {
        const known = ["/repo/.worktrees/feat/login"];
        expect(extractWorktreeName("/repo/.worktrees/feat/login/src", known)).toBe("feat/login");
    });

    test("extracts deeply slashed branch name using known cwds", () => {
        const known = ["/repo/.worktrees/a/b/c"];
        expect(extractWorktreeName("/repo/.worktrees/a/b/c/src/lib", known)).toBe("a/b/c");
    });

    test("picks longest matching known cwd", () => {
        const known = [
            "/repo/.worktrees/feat",
            "/repo/.worktrees/feat/login",
        ];
        expect(extractWorktreeName("/repo/.worktrees/feat/login/src", known)).toBe("feat/login");
    });

    test("falls back to first segment without known cwds", () => {
        // Without known cwds, slashed branches fall back to first segment
        expect(extractWorktreeName("/repo/.worktrees/feat/login/src")).toBe("feat");
    });

    test("ignores known cwds from different repos", () => {
        const known = ["/other-repo/.worktrees/feat/login"];
        // No match from our repo, falls back to first segment
        expect(extractWorktreeName("/repo/.worktrees/feat/login/src", known)).toBe("feat");
    });

    test("handles trailing slashes", () => {
        expect(extractWorktreeName("/repo/.worktrees/fix-bar/")).toBe("fix-bar");
    });

    test("returns null when nothing after marker", () => {
        expect(extractWorktreeName("/repo/.worktrees/")).toBeNull();
    });

    test("ignores nested cwds when worktreeRoots filters them", () => {
        // If raw session cwds include nested subdirs, worktreeRoots strips them
        const rawCwds = [
            "/repo/.worktrees/feat/login",
            "/repo/.worktrees/feat/login/src",
        ];
        const roots = worktreeRoots(rawCwds);
        expect(extractWorktreeName("/repo/.worktrees/feat/login/src", roots)).toBe("feat/login");
    });
});

describe("worktreeRoots", () => {
    test("filters out nested subdirectories", () => {
        const cwds = [
            "/repo/.worktrees/feat/login",
            "/repo/.worktrees/feat/login/src",
            "/repo/.worktrees/feat/login/src/lib",
        ];
        expect(worktreeRoots(cwds)).toEqual(["/repo/.worktrees/feat/login"]);
    });

    test("keeps multiple distinct worktree roots", () => {
        const cwds = [
            "/repo/.worktrees/feat/login",
            "/repo/.worktrees/fix/bug",
            "/repo/.worktrees/feat/login/src",
        ];
        const roots = worktreeRoots(cwds);
        expect(roots).toContain("/repo/.worktrees/feat/login");
        expect(roots).toContain("/repo/.worktrees/fix/bug");
        expect(roots).toHaveLength(2);
    });

    test("ignores non-worktree paths", () => {
        const cwds = ["/projects/app", "/repo/.worktrees/main"];
        expect(worktreeRoots(cwds)).toEqual(["/repo/.worktrees/main"]);
    });

    test("returns empty array when no worktree paths", () => {
        expect(worktreeRoots(["/home/user/code"])).toEqual([]);
    });

    test("handles trailing slashes", () => {
        const cwds = ["/repo/.worktrees/feat/login/", "/repo/.worktrees/feat/login/src"];
        expect(worktreeRoots(cwds)).toEqual(["/repo/.worktrees/feat/login"]);
    });
});
