import { execFileSync } from "node:child_process";
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileExplorerService } from "./file-explorer-service.js";

let gitAvailable = false;
try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    gitAvailable = true;
} catch {
    gitAvailable = false;
}
const testIfGit = gitAvailable ? test : test.skip;

// ── Mock workspace module ──────────────────────────────────────────────────
// Separate controls so tests can independently configure path access vs roots.
let mockCwdAllowed = true;
let mockRoots: string[] = [];
mock.module("../workspace.js", () => ({
    isCwdAllowed: (_cwd: string) => mockCwdAllowed,
    getWorkspaceRoots: () => mockRoots,
}));

// ── Fake socket ─────────────────────────────────────────────────────────────
function createFakeSocket() {
    const listeners = new Map<string, ((...args: any[]) => void)[]>();
    const emitted: { event: string; data: any }[] = [];

    return {
        on(event: string, fn: (...args: any[]) => void) {
            const list = listeners.get(event) ?? [];
            list.push(fn);
            listeners.set(event, list);
        },
        off(event: string, fn: (...args: any[]) => void) {
            const list = listeners.get(event) ?? [];
            listeners.set(event, list.filter((f) => f !== fn));
        },
        emit(event: string, data: any) {
            emitted.push({ event, data });
        },
        listeners,
        emitted,
        async trigger(event: string, data: any) {
            const fns = listeners.get(event) ?? [];
            for (const fn of fns) await fn(data);
        },
        serviceMessages(): any[] {
            return emitted
                .filter((e) => e.event === "service_message" && e.data?.serviceId === "file-explorer")
                .map((e) => e.data);
        },
    };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("FileExplorerService — browse_directory", () => {
    let tmpDir: string;
    let socket: ReturnType<typeof createFakeSocket>;
    let service: FileExplorerService;

    beforeEach(() => {
        mockCwdAllowed = true;
        mockRoots = [];

        tmpDir = mkdtempSync(join(tmpdir(), "browse-test-"));

        // tmpDir/
        //   project-a/
        //   project-b/
        //   .git/
        //   node_modules/
        //   .ssh/           (sensitive)
        //   .config/        (sensitive)
        //   regular-file.txt
        //   symlink-to-dir -> project-a
        //   symlink-broken -> nonexistent
        mkdirSync(join(tmpDir, "project-a"));
        mkdirSync(join(tmpDir, "project-b"));
        mkdirSync(join(tmpDir, ".git"));
        mkdirSync(join(tmpDir, "node_modules"));
        mkdirSync(join(tmpDir, ".ssh"));
        mkdirSync(join(tmpDir, ".config"));
        writeFileSync(join(tmpDir, "regular-file.txt"), "hello");
        symlinkSync(join(tmpDir, "project-a"), join(tmpDir, "symlink-to-dir"));
        symlinkSync(join(tmpDir, "nonexistent"), join(tmpDir, "symlink-broken"));

        socket = createFakeSocket();
        service = new FileExplorerService();
        service.init(socket as any, { isShuttingDown: () => false });
    });

    afterEach(() => {
        service.dispose();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    function getLastDirNames(): string[] {
        const msg = socket.serviceMessages().pop();
        return (msg?.payload?.directories as any[])?.map((d: any) => d.name) ?? [];
    }

    test("lists only directories, excludes files", async () => {
        await socket.trigger("browse_directory", { requestId: "r1", path: tmpDir });
        const names = getLastDirNames();
        expect(names).toContain("project-a");
        expect(names).toContain("project-b");
        expect(names).not.toContain("regular-file.txt");
    });

    test("excludes .git and node_modules", async () => {
        await socket.trigger("browse_directory", { requestId: "r2", path: tmpDir });
        const names = getLastDirNames();
        expect(names).not.toContain(".git");
        expect(names).not.toContain("node_modules");
    });

    test("includes symlinks to directories", async () => {
        await socket.trigger("browse_directory", { requestId: "r3", path: tmpDir });
        const names = getLastDirNames();
        expect(names).toContain("symlink-to-dir");
    });

    test("excludes broken symlinks", async () => {
        await socket.trigger("browse_directory", { requestId: "r4", path: tmpDir });
        const names = getLastDirNames();
        expect(names).not.toContain("symlink-broken");
    });

    test("filters sensitive dotfolders when outside workspace roots", async () => {
        // Roots configured but tmpDir is NOT under any of them → insideRoot=false
        mockRoots = ["/some/other/root"];

        await socket.trigger("browse_directory", { requestId: "r5", path: tmpDir });
        const names = getLastDirNames();
        expect(names).not.toContain(".ssh");
        expect(names).not.toContain(".config");
        expect(names).toContain("project-a");
        expect(names).toContain("project-b");
    });

    test("shows all dotfolders when inside workspace root", async () => {
        mockRoots = [tmpDir];

        await socket.trigger("browse_directory", { requestId: "r6", path: tmpDir });
        const names = getLastDirNames();
        expect(names).toContain(".ssh");
        expect(names).toContain(".config");
    });

    test("shows all dotfolders when no roots configured (unscoped)", async () => {
        mockRoots = [];

        await socket.trigger("browse_directory", { requestId: "r6b", path: tmpDir });
        const names = getLastDirNames();
        expect(names).toContain(".ssh");
        expect(names).toContain(".config");
    });

    test("returns error for missing path", async () => {
        await socket.trigger("browse_directory", { requestId: "r7", path: "" });
        const msg = socket.serviceMessages().pop();
        expect(msg?.payload?.ok).toBe(false);
        expect(msg?.payload?.message).toBe("Missing path");
    });

    test("returns error for disallowed path", async () => {
        mockCwdAllowed = false;

        await socket.trigger("browse_directory", { requestId: "r8", path: "/etc" });
        const msg = socket.serviceMessages().pop();
        expect(msg?.payload?.ok).toBe(false);
        expect(msg?.payload?.message).toBe("Path outside allowed roots");
    });

    test("returns error for non-existent path", async () => {
        await socket.trigger("browse_directory", { requestId: "r9", path: join(tmpDir, "nonexistent") });
        const msg = socket.serviceMessages().pop();
        expect(msg?.payload?.ok).toBe(false);
        expect(msg?.payload?.message).toContain("ENOENT");
    });

    test("results are sorted alphabetically", async () => {
        await socket.trigger("browse_directory", { requestId: "r10", path: tmpDir });
        const names = getLastDirNames();
        const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
        expect(names).toEqual(sorted);
    });

    test("dispose removes listener", () => {
        const before = socket.listeners.get("browse_directory")?.length ?? 0;
        expect(before).toBeGreaterThan(0);
        service.dispose();
        const after = socket.listeners.get("browse_directory")?.length ?? 0;
        expect(after).toBe(0);
    });
});

// ── inspect_folders ────────────────────────────────────────────────────────

describe("FileExplorerService — inspect_folders", () => {
    let tmpDir: string;
    let repoRoot: string;
    let subDir: string;
    let worktreeDir: string;
    let plainDir: string;
    let socket: ReturnType<typeof createFakeSocket>;
    let service: FileExplorerService;

    beforeEach(() => {
        if (!gitAvailable) return;
        mockCwdAllowed = true;
        mockRoots = [];

        tmpDir = mkdtempSync(join(tmpdir(), "inspect-test-"));
        repoRoot = join(tmpDir, "repo");
        subDir = join(repoRoot, "packages", "ui");
        worktreeDir = join(tmpDir, "wt-fix");
        plainDir = join(tmpDir, "plain");

        mkdirSync(subDir, { recursive: true });
        mkdirSync(plainDir, { recursive: true });

        execFileSync("git", ["init", repoRoot]);
        execFileSync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
        execFileSync("git", ["-C", repoRoot, "config", "user.name", "Test User"]);
        writeFileSync(join(repoRoot, "README.md"), "# repo");
        execFileSync("git", ["-C", repoRoot, "add", "."]);
        execFileSync("git", ["-C", repoRoot, "commit", "-m", "init"]);
        execFileSync("git", ["-C", repoRoot, "worktree", "add", "-b", "fix-branch", worktreeDir, "HEAD"]);

        // Resolve symlinks so assertions match git's canonical paths on macOS.
        repoRoot = realpathSync(repoRoot);
        subDir = realpathSync(subDir);
        worktreeDir = realpathSync(worktreeDir);
        plainDir = realpathSync(plainDir);

        socket = createFakeSocket();
        service = new FileExplorerService();
        service.init(socket as any, { isShuttingDown: () => false });
    });

    afterEach(() => {
        if (service) service.dispose();
        if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    function getLastPayload(): any {
        const msg = socket.serviceMessages().pop();
        return msg?.payload;
    }

    function findMeta(path: string) {
        const payload = getLastPayload();
        return payload?.folders?.find((f: any) => f.path === path);
    }

    testIfGit("returns git metadata for repo root, subdir, worktree, and non-repo", async () => {
        await socket.trigger("inspect_folders", {
            requestId: "i1",
            paths: [repoRoot, subDir, worktreeDir, plainDir],
        });

        const payload = getLastPayload();
        expect(payload.ok).toBe(true);
        expect(payload.folders).toHaveLength(4);

        const repoMeta = findMeta(repoRoot);
        expect(repoMeta.isGit).toBe(true);
        expect(repoMeta.repoRoot).toBe(repoRoot);
        expect(repoMeta.branch).toBe("main");
        expect(repoMeta.isWorktree).toBe(false);
        expect(repoMeta.mainRepoPath).toBe(repoRoot);

        const subMeta = findMeta(subDir);
        expect(subMeta.isGit).toBe(true);
        expect(subMeta.repoRoot).toBe(repoRoot);
        expect(subMeta.branch).toBe("main");
        expect(subMeta.isWorktree).toBe(false);
        expect(subMeta.mainRepoPath).toBe(repoRoot);

        const wtMeta = findMeta(worktreeDir);
        expect(wtMeta.isGit).toBe(true);
        expect(wtMeta.repoRoot).toBe(worktreeDir);
        expect(wtMeta.branch).toBe("fix-branch");
        expect(wtMeta.isWorktree).toBe(true);
        expect(wtMeta.mainRepoPath).toBe(repoRoot);

        const plainMeta = findMeta(plainDir);
        expect(plainMeta.isGit).toBe(false);
    });

    testIfGit("returns error when no paths are provided", async () => {
        await socket.trigger("inspect_folders", { requestId: "i2", paths: [] });
        const payload = getLastPayload();
        expect(payload.ok).toBe(false);
        expect(payload.message).toBe("Missing paths");
    });

    testIfGit("marks disallowed paths with an error and isGit=false", async () => {
        mockCwdAllowed = false;
        await socket.trigger("inspect_folders", { requestId: "i3", paths: [repoRoot] });
        const meta = findMeta(repoRoot);
        expect(meta.isGit).toBe(false);
        expect(meta.error).toBe("Path outside allowed roots");
    });
});
