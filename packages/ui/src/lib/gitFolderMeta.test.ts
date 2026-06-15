import { describe, test, expect } from "bun:test";
import { buildFolderMetaMap, formatWorktreeLabel, type FolderGitMetadata } from "./gitFolderMeta.js";

const META: FolderGitMetadata[] = [
    { path: "/code/repo", isGit: true, repoRoot: "/code/repo", branch: "main" },
    { path: "/code/repo-wt", isGit: true, repoRoot: "/code/repo-wt", branch: "fix", isWorktree: true, mainRepoPath: "/code/repo" },
    { path: "/code/plain", isGit: false },
];

describe("buildFolderMetaMap", () => {
    test("maps paths to metadata", () => {
        const map = buildFolderMetaMap(META);
        expect(map.get("/code/repo")?.branch).toBe("main");
        expect(map.get("/code/repo-wt")?.isWorktree).toBe(true);
        expect(map.get("/code/plain")?.isGit).toBe(false);
    });
});

describe("formatWorktreeLabel", () => {
    test("returns label when main repo is in the recent list", () => {
        const label = formatWorktreeLabel(META[1], new Set(["/code/repo", "/code/repo-wt"]));
        expect(label).toBe("worktree of repo");
    });

    test("returns null when main repo is not listed", () => {
        const label = formatWorktreeLabel(META[1], new Set(["/code/repo-wt"]));
        expect(label).toBeNull();
    });

    test("returns null for non-worktree entries", () => {
        const label = formatWorktreeLabel(META[0], new Set(["/code/repo"]));
        expect(label).toBeNull();
    });

    test("returns null for non-git entries", () => {
        const label = formatWorktreeLabel(META[2], new Set(["/code/repo"]));
        expect(label).toBeNull();
    });
});
