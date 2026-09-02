/**
 * Regression tests for git-service state-management fixes (2026-08 audit §3):
 *  1. caller-controlled cwd is authorized against runner-owned session cwd
 *  2. shared mutations lock by --git-common-dir (linked worktrees serialize)
 *  3. metadata changes broadcast versioned git_repo_changed to all repo subscribers
 *  4. in-use worktree removal is rejected unless explicitly overridden
 *  5. metadata watchers are rebuilt after checkout (external checkout is seen)
 *  6. stage/unstage serialize per worktree with a retryable busy result
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceEnvelope } from "../service-handler.js";
import { GitService } from "./git-service.js";

function createMockSocket() {
    const emitted: ServiceEnvelope[] = [];
    const listeners = new Map<string, Function[]>();
    return {
        emitted,
        listeners,
        emit: (event: string, envelope: ServiceEnvelope) => {
            if (event === "service_message") emitted.push(envelope);
        },
        on: (event: string, handler: Function) => {
            listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        },
        off: (event: string, handler: Function) => {
            listeners.set(event, (listeners.get(event) ?? []).filter((fn) => fn !== handler));
        },
    };
}

function dispatch(socket: ReturnType<typeof createMockSocket>, envelope: ServiceEnvelope): void {
    for (const handler of socket.listeners.get("service_message") ?? []) handler(envelope);
}

async function waitForResult(
    socket: ReturnType<typeof createMockSocket>,
    requestId: string,
    type: string,
    timeoutMs = 5_000,
): Promise<ServiceEnvelope> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const hit = socket.emitted.find((e) => e.requestId === requestId && e.type === type);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`Timed out waiting for ${type} (${requestId})`);
}

async function waitForEnvelope(
    socket: ReturnType<typeof createMockSocket>,
    matcher: (e: ServiceEnvelope & { sessionId?: string }) => boolean,
    timeoutMs = 5_000,
): Promise<ServiceEnvelope> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const hit = socket.emitted.find(matcher as (e: ServiceEnvelope) => boolean);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("Timed out waiting for matching envelope");
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Create a real repo with one commit; returns its path. */
function makeRepo(root: string, name: string): string {
    const repo = join(root, name);
    execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
    git(repo, "config", "user.email", "t@t.test");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "init");
    return repo;
}

let root: string;
let repoA: string;
let repoB: string;
let worktreeA2: string;

beforeAll(() => {
    // realpath: on macOS tmpdir() is a /var → /private/var symlink, but git
    // reports realpaths — known-worktree and watcher path comparisons need them.
    root = realpathSync(mkdtempSync(join(tmpdir(), "git-state-test-")));
    repoA = makeRepo(root, "repoA");
    repoB = makeRepo(root, "repoB");
    worktreeA2 = join(root, "repoA-wt2");
    git(repoA, "worktree", "add", "-b", "wt2", worktreeA2);
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("cwd authority (fix 1)", () => {
    test("a session cannot mutate a repo outside its own repository family", async () => {
        // Two sessions on the same runner: session-a lives in repoA, session-b in repoB.
        const service = new GitService({
            getSessionCwd: (id) => (id === "session-a" ? repoA : id === "session-b" ? repoB : null),
        });
        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        // session-b tries to stage in repoA (a path under globally allowed roots).
        dispatch(socket, {
            serviceId: "git", type: "git_stage", requestId: "x1",
            sessionId: "session-b", payload: { cwd: repoA, all: true },
        });
        const denied = await waitForResult(socket, "x1", "git_stage_result");
        expect((denied.payload as any).ok).toBe(false);
        expect((denied.payload as any).message).toContain("session's repository");

        // session-a in its own repo is fine.
        writeFileSync(join(repoA, "b.txt"), "b\n");
        dispatch(socket, {
            serviceId: "git", type: "git_stage", requestId: "x2",
            sessionId: "session-a", payload: { cwd: repoA, all: true },
        });
        const ok = await waitForResult(socket, "x2", "git_stage_result");
        expect((ok.payload as any).ok).toBe(true);
        git(repoA, "restore", "--staged", ":/");

        service.dispose();
    });

    test("a linked worktree of the session's repo is authorized (same common dir)", async () => {
        const service = new GitService({
            getSessionCwd: () => repoA,
        });
        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatch(socket, {
            serviceId: "git", type: "git_status", requestId: "x3",
            sessionId: "session-a", payload: { cwd: worktreeA2 },
        });
        const res = await waitForResult(socket, "x3", "git_status_result");
        expect((res.payload as any).ok).toBe(true);
        expect((res.payload as any).branch).toBe("wt2");

        service.dispose();
    });

    test("sessions without runner cwd metadata fall back to allowed-roots validation", async () => {
        const service = new GitService({ getSessionCwd: () => null });
        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatch(socket, {
            serviceId: "git", type: "git_status", requestId: "x4",
            sessionId: "session-unknown", payload: { cwd: repoB },
        });
        const res = await waitForResult(socket, "x4", "git_status_result");
        expect((res.payload as any).ok).toBe(true);

        service.dispose();
    });
});

describe("common-dir mutation locking (fix 2)", () => {
    test("shared mutations in two linked worktrees of one repo serialize on one lock", async () => {
        // Fake exec: both worktrees report the SAME --git-common-dir; the first
        // checkout blocks on a gate, the second must not start until released.
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => { release = r; });
        const checkoutStarts: string[] = [];

        const service = new GitService({
            execGit: async (args, { cwd }) => {
                if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
                    return { stdout: "/repo/.git\n", stderr: "" };
                }
                if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
                    return { stdout: `${cwd}\n`, stderr: "" };
                }
                if (args[0] === "rev-parse") return { stdout: "main\n", stderr: "" };
                if (args[0] === "checkout") {
                    checkoutStarts.push(cwd);
                    await gate;
                    return { stdout: "", stderr: "" };
                }
                return { stdout: "", stderr: "" };
            },
        });
        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatch(socket, {
            serviceId: "git", type: "git_checkout", requestId: "c1",
            sessionId: "s1", payload: { cwd: "/repo/wt1", branch: "feature-1" },
        });
        dispatch(socket, {
            serviceId: "git", type: "git_checkout", requestId: "c2",
            sessionId: "s2", payload: { cwd: "/repo/wt2", branch: "feature-2" },
        });

        // First checkout starts; second must be held behind the shared repo lock.
        const start = Date.now();
        while (checkoutStarts.length === 0 && Date.now() - start < 2000) {
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(checkoutStarts.length).toBe(1);
        await new Promise((r) => setTimeout(r, 150));
        expect(checkoutStarts.length).toBe(1);

        release();
        await waitForResult(socket, "c1", "git_checkout_result");
        const second = await waitForResult(socket, "c2", "git_checkout_result");
        expect((second.payload as any).ok).toBe(true);
        expect(checkoutStarts.length).toBe(2);

        service.dispose();
    });
});

describe("repo-change broadcast (fix 3) + watcher rebuild (fix 5)", () => {
    test("external checkout pushes git_repo_changed and fresh status to subscribers", async () => {
        const service = new GitService({});
        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        // Subscribe a session to repoB.
        dispatch(socket, {
            serviceId: "git", type: "git_status", requestId: "s1",
            sessionId: "viewer-1", payload: { cwd: repoB },
        });
        await waitForResult(socket, "s1", "git_status_result");
        // Watcher registration is async — give fs.watch handles time to attach
        // before making the external change they are supposed to observe.
        await new Promise((r) => setTimeout(r, 500));

        // External change: checkout a new branch outside the service.
        git(repoB, "checkout", "-b", "external-branch");

        // Every subscriber gets the versioned invalidation broadcast...
        const changed = await waitForEnvelope(
            socket,
            (e) => e.type === "git_repo_changed" && (e.payload as any).cwd === repoB,
        );
        expect(typeof (changed.payload as any).version).toBe("number");
        expect((changed as any).sessionId).toBe("viewer-1");

        // ...and the proactive status push reflects the NEW branch, which proves
        // the metadata watchers survived/rebuilt across the HEAD change.
        await waitForEnvelope(
            socket,
            (e) => e.type === "git_status_result" && !e.requestId && (e.payload as any).branch === "external-branch",
        );

        // Watchers must still be live for the new branch ref: a second external
        // change (commit moves the new branch ref) is detected too.
        // (Watcher rebuild is async — let the new fs.watch handles attach.)
        await new Promise((r) => setTimeout(r, 500));
        socket.emitted.length = 0;
        writeFileSync(join(repoB, "c.txt"), "c\n");
        git(repoB, "add", "-A");
        git(repoB, "commit", "-m", "external commit");
        await waitForEnvelope(socket, (e) => e.type === "git_repo_changed");

        git(repoB, "checkout", "main");
        service.dispose();
    }, 20_000);

    test("a mutation by one session broadcasts git_repo_changed to a subscriber in a linked worktree", async () => {
        const service = new GitService({});
        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        // viewer-wt subscribes in the linked worktree, viewer-main in the main checkout.
        dispatch(socket, {
            serviceId: "git", type: "git_status", requestId: "m1",
            sessionId: "viewer-main", payload: { cwd: repoA },
        });
        await waitForResult(socket, "m1", "git_status_result");
        dispatch(socket, {
            serviceId: "git", type: "git_status", requestId: "m2",
            sessionId: "viewer-wt", payload: { cwd: worktreeA2 },
        });
        await waitForResult(socket, "m2", "git_status_result");

        // viewer-main stages a file via the service → the linked-worktree
        // subscriber must receive the family-wide invalidation broadcast.
        writeFileSync(join(repoA, "d.txt"), "d\n");
        dispatch(socket, {
            serviceId: "git", type: "git_stage", requestId: "m3",
            sessionId: "viewer-main", payload: { cwd: repoA, all: true },
        });
        await waitForResult(socket, "m3", "git_stage_result");

        const wtBroadcast = await waitForEnvelope(
            socket,
            (e) => e.type === "git_repo_changed"
                && (e.payload as any).cwd === worktreeA2
                && (e as any).sessionId === "viewer-wt",
        );
        expect((wtBroadcast.payload as any).version).toBeGreaterThan(0);

        git(repoA, "restore", "--staged", ":/");
        rmSync(join(repoA, "d.txt"), { force: true });
        service.dispose();
    });
});

describe("in-use worktree removal (fix 4)", () => {
    test("removal of a live session's worktree is rejected, even with force", async () => {
        const wt = join(root, "repoA-wt-inuse");
        git(repoA, "worktree", "add", "-b", "wt-inuse", wt);
        try {
            const service = new GitService({
                getActiveSessionCwds: () => [join(wt, "sub", "dir")], // session cwd inside the worktree
            });
            const socket = createMockSocket();
            service.init(socket as any, { isShuttingDown: () => false });

            dispatch(socket, {
                serviceId: "git", type: "git_worktree_remove", requestId: "w1",
                sessionId: "s1", payload: { cwd: repoA, path: wt, force: true },
            });
            const denied = await waitForResult(socket, "w1", "git_worktree_remove_result");
            expect((denied.payload as any).ok).toBe(false);
            expect((denied.payload as any).reason).toBe("in_use");

            // Explicit override goes through.
            dispatch(socket, {
                serviceId: "git", type: "git_worktree_remove", requestId: "w2",
                sessionId: "s1", payload: { cwd: repoA, path: wt, force: true, overrideInUse: true },
            });
            const removed = await waitForResult(socket, "w2", "git_worktree_remove_result");
            expect((removed.payload as any).ok).toBe(true);

            service.dispose();
        } finally {
            rmSync(wt, { recursive: true, force: true });
            try { git(repoA, "worktree", "prune"); } catch { /* already gone */ }
        }
    });
});

describe("index mutation serialization (fix 6)", () => {
    test("a stage that cannot acquire the worktree lock returns a retryable busy result", async () => {
        // Immediate-callback timers + a fast-forwarding clock make the busy
        // deadline trip without real sleeps.
        let now = 0;
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => { release = r; });

        const service = new GitService({
            now: () => now,
            setTimeoutFn: (cb) => { now += 1000; queueMicrotask(cb); return 0 as unknown as ReturnType<typeof setTimeout>; },
            clearTimeoutFn: () => {},
            execGit: async (args, { cwd: _cwd }) => {
                if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: "/repo\n", stderr: "" };
                if (args[0] === "rev-parse") return { stdout: "main\n", stderr: "" };
                if (args[0] === "add") { await gate; return { stdout: "", stderr: "" }; }
                return { stdout: "", stderr: "" };
            },
        });
        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatch(socket, {
            serviceId: "git", type: "git_stage", requestId: "b1",
            sessionId: "s1", payload: { cwd: "/repo", all: true },
        });
        dispatch(socket, {
            serviceId: "git", type: "git_stage", requestId: "b2",
            sessionId: "s2", payload: { cwd: "/repo", all: true },
        });

        const busy = await waitForResult(socket, "b2", "git_stage_result");
        expect((busy.payload as any).ok).toBe(false);
        expect((busy.payload as any).reason).toBe("busy");
        expect((busy.payload as any).retryable).toBe(true);

        release();
        const first = await waitForResult(socket, "b1", "git_stage_result");
        expect((first.payload as any).ok).toBe(true);

        service.dispose();
    });
});
