import { describe, test, expect } from "bun:test";
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

function dispatchServiceMessage(socket: ReturnType<typeof createMockSocket>, envelope: ServiceEnvelope): void {
    const handlers = socket.listeners.get("service_message") ?? [];
    for (const handler of handlers) handler(envelope);
}

async function waitForResult(
    socket: ReturnType<typeof createMockSocket>,
    requestId: string,
    type: string,
): Promise<ServiceEnvelope> {
    for (let i = 0; i < 200; i++) {
        const hit = socket.emitted.find((e) => e.requestId === requestId && e.type === type);
        if (hit) return hit;
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`Timed out waiting for ${type} (${requestId})`);
}

async function waitForEnvelope(
    socket: ReturnType<typeof createMockSocket>,
    matcher: (envelope: ServiceEnvelope) => boolean,
    timeoutMs = 2_000,
): Promise<ServiceEnvelope> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const hit = socket.emitted.find(matcher);
        if (hit) return hit;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for matching envelope after ${timeoutMs}ms`);
}

async function waitForCondition(check: () => boolean, timeoutMs = 2_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

describe("GitService status caching", () => {
    test("caches status for a short TTL and refreshes after expiry", async () => {
        let now = 1_000;
        let statusCalls = 0;

        const service = new GitService({
            now: () => now,
            execGit: async (args) => {
                switch (args[0]) {
                    case "rev-parse":
                        if (args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "" };
                        return { stdout: "/repo\n", stderr: "" };
                    case "status":
                        statusCalls++;
                        return { stdout: ` M file-${statusCalls}.ts\0`, stderr: "" };
                    case "diff":
                        return { stdout: "", stderr: "" };
                    case "rev-list":
                        return { stdout: "0 0\n", stderr: "" };
                    default:
                        throw new Error(`Unexpected git args: ${args.join(" ")}`);
                }
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_status",
            requestId: "r1",
            payload: { cwd: "/repo" },
        });
        const r1 = await waitForResult(socket, "r1", "git_status_result");

        now += 500;
        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_status",
            requestId: "r2",
            payload: { cwd: "/repo" },
        });
        const r2 = await waitForResult(socket, "r2", "git_status_result");

        expect(statusCalls).toBe(1);
        expect((r1.payload as any).changes[0].path).toBe("file-1.ts");
        expect((r2.payload as any).changes[0].path).toBe("file-1.ts");

        now += 2_600;
        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_status",
            requestId: "r3",
            payload: { cwd: "/repo" },
        });
        const r3 = await waitForResult(socket, "r3", "git_status_result");

        expect(statusCalls).toBe(2);
        expect((r3.payload as any).changes[0].path).toBe("file-2.ts");
    });

    test("dedupes in-flight status requests by cwd", async () => {
        let statusCalls = 0;
        let releaseStatus: () => void = () => {
            throw new Error("Expected releaseStatus resolver to be set");
        };
        const statusGate = new Promise<void>((resolve) => {
            releaseStatus = resolve;
        });

        const service = new GitService({
            execGit: async (args) => {
                switch (args[0]) {
                    case "rev-parse":
                        if (args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "" };
                        return { stdout: "/repo\n", stderr: "" };
                    case "status":
                        statusCalls++;
                        await statusGate;
                        return { stdout: " M shared.ts\0", stderr: "" };
                    case "diff":
                        return { stdout: "", stderr: "" };
                    case "rev-list":
                        return { stdout: "0 0\n", stderr: "" };
                    default:
                        throw new Error(`Unexpected git args: ${args.join(" ")}`);
                }
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_status",
            requestId: "a",
            payload: { cwd: "/repo" },
        });
        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_status",
            requestId: "b",
            payload: { cwd: "/repo" },
        });

        expect(statusCalls).toBe(1);

        releaseStatus();

        const a = await waitForResult(socket, "a", "git_status_result");
        const b = await waitForResult(socket, "b", "git_status_result");

        expect((a.payload as any).ok).toBe(true);
        expect((b.payload as any).ok).toBe(true);
        expect(statusCalls).toBe(1);
    });

    test("invalidates cached status after git mutations", async () => {
        const cwd = "/repo";
        let statusCalls = 0;

        const service = new GitService({
            execGit: async (args) => {
                const cmd = args[0];
                if (cmd === "rev-parse") {
                    if (args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "" };
                    return { stdout: `${cwd}\n`, stderr: "" };
                }
                if (cmd === "status") {
                    statusCalls++;
                    return { stdout: ` M state-${statusCalls}.ts\0`, stderr: "" };
                }
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                if (cmd === "add" || cmd === "restore" || cmd === "checkout") return { stdout: "", stderr: "" };
                if (cmd === "commit") return { stdout: "[main abc1234] message\n", stderr: "" };
                if (cmd === "fetch" || cmd === "pull" || cmd === "push" || cmd === "rebase") return { stdout: "ok", stderr: "" };
                if (cmd === "config" && args[2]?.endsWith(".remote")) return { stdout: "origin\n", stderr: "" };
                if (cmd === "config" && args[2]?.endsWith(".merge")) return { stdout: "refs/heads/main\n", stderr: "" };
                if (cmd === "remote") return { stdout: "origin\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        let req = 0;
        const askStatus = async () => {
            req++;
            const requestId = `status-${req}`;
            dispatchServiceMessage(socket, {
                serviceId: "git",
                type: "git_status",
                requestId,
                payload: { cwd },
            });
            return waitForResult(socket, requestId, "git_status_result");
        };

        // Prime cache and verify it hits.
        await askStatus();
        await askStatus();
        expect(statusCalls).toBe(1);

        const operations: Array<{ type: string; payload: Record<string, unknown>; resultType: string }> = [
            { type: "git_stage", payload: { cwd, all: true }, resultType: "git_stage_result" },
            { type: "git_unstage", payload: { cwd, all: true }, resultType: "git_unstage_result" },
            { type: "git_commit", payload: { cwd, message: "msg" }, resultType: "git_commit_result" },
            { type: "git_checkout", payload: { cwd, branch: "main", isRemote: false }, resultType: "git_checkout_result" },
            { type: "git_push", payload: { cwd, setUpstream: false }, resultType: "git_push_result" },
            { type: "git_pull", payload: { cwd }, resultType: "git_pull_result" },
        ];

        for (const op of operations) {
            req++;
            const requestId = `op-${req}`;
            dispatchServiceMessage(socket, {
                serviceId: "git",
                type: op.type,
                requestId,
                payload: op.payload,
            });

            const opResult = await waitForResult(socket, requestId, op.resultType);
            expect((opResult.payload as any).ok).toBe(true);

            await askStatus();
            expect(statusCalls).toBeGreaterThan(1);
        }

        // 1 initial fetch + one refresh after each mutation.
        expect(statusCalls).toBe(1 + operations.length);
    });
});

describe("GitService git metadata watchers", () => {
    test("tracks subscribers by session cwd and cleans up stale repo watchers", async () => {
        const watchListeners = new Map<string, () => void>();
        const closedPaths: string[] = [];

        const service = new GitService({
            watchFs: (path, listener) => {
                watchListeners.set(path, listener);
                return {
                    close: () => {
                        closedPaths.push(path);
                        watchListeners.delete(path);
                    },
                };
            },
            execGit: async (args, options) => {
                if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "" };
                if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: `${options.cwd}\n`, stderr: "" };
                if (args[0] === "rev-parse" && args[1] === "--git-path") return { stdout: `${options.cwd}/.git/${args[2]}\n`, stderr: "" };
                if (args[0] === "status") return { stdout: " M watched.ts\0", stderr: "" };
                if (args[0] === "diff") return { stdout: "", stderr: "" };
                if (args[0] === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_status",
            requestId: "repo-a",
            sessionId: "session-1",
            payload: { cwd: "/repo-a" },
        });
        await waitForResult(socket, "repo-a", "git_status_result");

        await waitForCondition(() => Array.from(watchListeners.keys()).some((p) => p.startsWith("/repo-a/.git/")));

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_status",
            requestId: "repo-b",
            sessionId: "session-1",
            payload: { cwd: "/repo-b" },
        });
        await waitForResult(socket, "repo-b", "git_status_result");

        await waitForCondition(() => closedPaths.some((p) => p.startsWith("/repo-a/.git/")));
        expect(Array.from(watchListeners.keys()).some((p) => p.startsWith("/repo-a/.git/"))).toBe(false);
        expect(Array.from(watchListeners.keys()).some((p) => p.startsWith("/repo-b/.git/"))).toBe(true);

        service.dispose();
        expect(Array.from(watchListeners.keys()).length).toBe(0);
    });

    test("removes repo subscriptions/watchers when a session ends", async () => {
        const watchListeners = new Map<string, () => void>();

        const service = new GitService({
            watchFs: (path, listener) => {
                watchListeners.set(path, listener);
                return {
                    close: () => {
                        watchListeners.delete(path);
                    },
                };
            },
            execGit: async (args, options) => {
                if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "" };
                if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: `${options.cwd}\n`, stderr: "" };
                if (args[0] === "rev-parse" && args[1] === "--git-path") return { stdout: `${options.cwd}/.git/${args[2]}\n`, stderr: "" };
                if (args[0] === "status") return { stdout: " M watched.ts\0", stderr: "" };
                if (args[0] === "diff") return { stdout: "", stderr: "" };
                if (args[0] === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_status",
            requestId: "repo-a",
            sessionId: "session-1",
            payload: { cwd: "/repo-a" },
        });
        await waitForResult(socket, "repo-a", "git_status_result");
        await waitForCondition(() => Array.from(watchListeners.keys()).some((p) => p.startsWith("/repo-a/.git/")));

        service.handleSessionEnded("session-1");

        expect(Array.from(watchListeners.keys()).some((p) => p.startsWith("/repo-a/.git/"))).toBe(false);
    });

    test("normalizes relative git metadata paths to absolute paths before watching", async () => {
        const watchPaths: string[] = [];

        const service = new GitService({
            watchFs: (path) => {
                watchPaths.push(path);
                return { close: () => {} };
            },
            execGit: async (args, options) => {
                if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "" };
                if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: "/repo\n", stderr: "" };
                if (args[0] === "rev-parse" && args[1] === "--git-path") {
                    const key = args[2];
                    if (key === "HEAD") return { stdout: "../.git/HEAD\n", stderr: "" };
                    if (key === "index") return { stdout: "../.git/index\n", stderr: "" };
                    if (key === "packed-refs") return { stdout: "../.git/packed-refs\n", stderr: "" };
                    if (key === "FETCH_HEAD") return { stdout: "../.git/FETCH_HEAD\n", stderr: "" };
                    if (key === "refs/heads") return { stdout: "../.git/refs/heads\n", stderr: "" };
                    if (key === "refs/remotes") return { stdout: "../.git/refs/remotes\n", stderr: "" };
                    if (key === "refs/heads/main") return { stdout: "../.git/refs/heads/main\n", stderr: "" };
                    if (key === "refs/remotes/origin/main") return { stdout: "../.git/refs/remotes/origin/main\n", stderr: "" };
                }
                if (args[0] === "symbolic-ref" && args[1] === "-q" && args[2] === "HEAD") {
                    return { stdout: "refs/heads/main\n", stderr: "" };
                }
                if (args[0] === "rev-parse" && args[1] === "--symbolic-full-name" && args[2] === "@{u}") {
                    return { stdout: "refs/remotes/origin/main\n", stderr: "" };
                }
                if (args[0] === "status") return { stdout: " M watched.ts\0", stderr: "" };
                if (args[0] === "diff") return { stdout: "", stderr: "" };
                if (args[0] === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_status",
            requestId: "repo-subdir",
            sessionId: "session-1",
            payload: { cwd: "/repo/subdir" },
        });
        await waitForResult(socket, "repo-subdir", "git_status_result");
        await waitForCondition(() => watchPaths.length > 0);

        expect(watchPaths).toContain("/repo/.git/HEAD");
        expect(watchPaths).toContain("/repo/.git/index");
        expect(watchPaths).toContain("/repo/.git/packed-refs");
        expect(watchPaths).toContain("/repo/.git/FETCH_HEAD");
        expect(watchPaths).toContain("/repo/.git/refs/heads");
        expect(watchPaths).toContain("/repo/.git/refs/remotes");
    });

    test("debounces metadata fs events and pushes status only to interested cwd subscribers", async () => {
        const watchListeners = new Map<string, () => void>();
        const statusCalls = new Map<string, number>();

        const service = new GitService({
            watchFs: (path, listener) => {
                watchListeners.set(path, listener);
                return {
                    close: () => {
                        watchListeners.delete(path);
                    },
                };
            },
            execGit: async (args, options) => {
                if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "" };
                if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: `${options.cwd}\n`, stderr: "" };
                if (args[0] === "rev-parse" && args[1] === "--git-path") return { stdout: `${options.cwd}/.git/${args[2]}\n`, stderr: "" };
                if (args[0] === "status") {
                    const next = (statusCalls.get(options.cwd) ?? 0) + 1;
                    statusCalls.set(options.cwd, next);
                    return { stdout: ` M ${options.cwd.replaceAll("/", "_")}-${next}.ts\0`, stderr: "" };
                }
                if (args[0] === "diff") return { stdout: "", stderr: "" };
                if (args[0] === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_status",
            requestId: "seed-a",
            sessionId: "session-a",
            payload: { cwd: "/repo-a" },
        });
        await waitForResult(socket, "seed-a", "git_status_result");

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_status",
            requestId: "seed-b",
            sessionId: "session-b",
            payload: { cwd: "/repo-b" },
        });
        await waitForResult(socket, "seed-b", "git_status_result");

        await waitForCondition(() => watchListeners.has("/repo-a/.git/HEAD"));

        socket.emitted.length = 0;
        const headWatcher = watchListeners.get("/repo-a/.git/HEAD");
        expect(headWatcher).toBeDefined();

        headWatcher?.();
        headWatcher?.();

        const pushed = await waitForEnvelope(
            socket,
            (envelope) => envelope.type === "git_status_result" && (envelope as any).sessionId === "session-a" && envelope.requestId === undefined,
        );

        expect((pushed.payload as any).ok).toBe(true);
        expect(socket.emitted.some((e) => e.type === "git_status_result" && (e as any).sessionId === "session-b" && e.requestId === undefined)).toBe(false);

        await new Promise((resolve) => setTimeout(resolve, 450));
        expect(statusCalls.get("/repo-a")).toBe(2); // one initial request + one debounced push
    });
});

describe("GitService git_full_status", () => {
    test("returns status + branches + worktrees in one response", async () => {
        const cwd = "/repo";

        const service = new GitService({
            execGit: async (args, options) => {
                const cmd = args[0];

                if (cmd === "rev-parse" && args[1] === "--abbrev-ref") {
                    return { stdout: "main\n", stderr: "" };
                }
                if (cmd === "rev-parse" && args[1] === "--show-toplevel") {
                    return { stdout: `${cwd}\n`, stderr: "" };
                }
                if (cmd === "status" && args.includes("-z")) {
                    return { stdout: " M src/index.ts\0", stderr: "" };
                }
                if (cmd === "status") {
                    return { stdout: " M src/index.ts\n", stderr: "" };
                }
                if (cmd === "diff") {
                    return { stdout: "", stderr: "" };
                }
                if (cmd === "rev-list") {
                    if (options.cwd === cwd) return { stdout: "2 1\n", stderr: "" };
                    return { stdout: "1 0\n", stderr: "" };
                }
                if (cmd === "for-each-ref" && args.includes("refs/heads")) {
                    return { stdout: "main\tabc1234\t2 hours ago\t*\nfeature/test\tdef5678\t1 day ago\t\n", stderr: "" };
                }
                if (cmd === "for-each-ref" && args.includes("refs/remotes")) {
                    return { stdout: "origin/main\tabc1234\t2 hours ago\n", stderr: "" };
                }
                if (cmd === "worktree") {
                    return {
                        stdout: `worktree ${cwd}\nHEAD abc123456789\nbranch refs/heads/main\n\nworktree ${cwd}/.worktrees/feature-test\nHEAD def56789abcd\nbranch refs/heads/feature/test\n`,
                        stderr: "",
                    };
                }

                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_full_status",
            requestId: "full-1",
            payload: { cwd },
        });

        const result = await waitForResult(socket, "full-1", "git_full_status_result");
        const payload = result.payload as any;

        expect(payload.ok).toBe(true);
        expect(payload.status.branch).toBe("main");
        expect(payload.status.changes).toEqual([{ status: " M", path: "src/index.ts" }]);
        expect(payload.currentBranch).toBe("main");
        expect(payload.branches.length).toBe(3);
        expect(payload.worktrees.length).toBe(2);
        expect(payload.worktrees[0].isMain).toBe(true);
    });

    test("re-collects branches/worktrees when generation changes mid full-status", async () => {
        const cwd = "/repo";
        let branchName = "main";
        let releaseStatus: () => void = () => {
            throw new Error("Expected status gate release function");
        };
        const statusGate = new Promise<void>((resolve) => {
            releaseStatus = resolve;
        });

        const service = new GitService({
            execGit: async (args, options) => {
                const cmd = args[0];

                if (cmd === "rev-parse" && args[1] === "--abbrev-ref") {
                    return { stdout: `${branchName}\n`, stderr: "" };
                }
                if (cmd === "rev-parse" && args[1] === "--show-toplevel") {
                    return { stdout: `${cwd}\n`, stderr: "" };
                }
                if (cmd === "status" && args.includes("-z")) {
                    await statusGate;
                    return { stdout: " M src/index.ts\0", stderr: "" };
                }
                if (cmd === "status") {
                    return { stdout: " M src/index.ts\n", stderr: "" };
                }
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                if (cmd === "for-each-ref" && args.includes("refs/heads")) {
                    if (branchName === "feature/new") {
                        return { stdout: "feature/new\tabc1234\tjust now\t*\nmain\tdef5678\t1 day ago\t\n", stderr: "" };
                    }
                    return { stdout: "main\tdef5678\t1 day ago\t*\nfeature/new\tabc1234\tjust now\t\n", stderr: "" };
                }
                if (cmd === "for-each-ref" && args.includes("refs/remotes")) {
                    return { stdout: "origin/main\tdef5678\t1 day ago\norigin/feature/new\tabc1234\tjust now\n", stderr: "" };
                }
                if (cmd === "worktree") {
                    return {
                        stdout: `worktree ${cwd}\nHEAD abc123456789\nbranch refs/heads/${branchName}\n`,
                        stderr: "",
                    };
                }
                if (cmd === "checkout") {
                    branchName = args[1] ?? branchName;
                    return { stdout: "", stderr: "" };
                }

                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_full_status",
            requestId: "full-race",
            payload: { cwd },
        });

        // Bump status generation while full-status is in-flight.
        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_checkout",
            requestId: "checkout-race",
            payload: { cwd, branch: "feature/new", isRemote: false },
        });
        await waitForResult(socket, "checkout-race", "git_checkout_result");

        releaseStatus();

        const result = await waitForResult(socket, "full-race", "git_full_status_result");
        const payload = result.payload as any;

        expect(payload.ok).toBe(true);
        expect(payload.status.branch).toBe("feature/new");
        expect(payload.currentBranch).toBe("feature/new");
        expect(payload.worktrees[0].branch).toBe("feature/new");
    });

    test("returns git_full_status_result error for missing cwd", async () => {
        const service = new GitService();
        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_full_status",
            requestId: "full-missing-cwd",
            payload: {},
        });

        const result = await waitForResult(socket, "full-missing-cwd", "git_full_status_result");
        expect(result.payload).toEqual({ ok: false, message: "Missing cwd" });
    });
});

describe("GitService pull/merge", () => {
    test("pull uses fetch + rebase with explicit upstream", async () => {
        const gitCalls: string[][] = [];

        const service = new GitService({
            execGit: async (args) => {
                gitCalls.push([...args]);
                const cmd = args[0];
                if (cmd === "fetch") return { stdout: "", stderr: "" };
                if (cmd === "rebase") return { stdout: "Applied 2 commits\n", stderr: "" };
                if (cmd === "merge") return { stdout: "Fast-forward\n", stderr: "" };
                if (cmd === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "" };
                if (cmd === "config" && args[2] === "branch.main.remote") return { stdout: "origin\n", stderr: "" };
                if (cmd === "config" && args[2] === "branch.main.merge") return { stdout: "refs/heads/main\n", stderr: "" };
                if (cmd === "rev-parse") return { stdout: "/tmp/pizzapi-test\n", stderr: "" };
                if (cmd === "status") return { stdout: "", stderr: "" };
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_pull",
            requestId: "pull-1",
            payload: { cwd: "/tmp/pizzapi-test" },
        });
        const r1 = await waitForResult(socket, "pull-1", "git_pull_result");
        expect((r1.payload as any).ok).toBe(true);
        expect(gitCalls).toContainEqual(["fetch", "origin", "main"]);
        expect(gitCalls).toContainEqual(["rebase", "origin/main"]);

        gitCalls.length = 0;

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_pull",
            requestId: "pull-2",
            payload: { cwd: "/tmp/pizzapi-test", rebase: false },
        });
        const r2 = await waitForResult(socket, "pull-2", "git_pull_result");
        expect((r2.payload as any).ok).toBe(true);
        expect(gitCalls).toContainEqual(["fetch", "origin", "main"]);
        expect(gitCalls).toContainEqual(["merge", "--ff-only", "origin/main"]);
    });

    test("pull fails with missingUpstream when tracking config is incomplete", async () => {
        const gitCalls: string[][] = [];

        const service = new GitService({
            execGit: async (args) => {
                gitCalls.push([...args]);
                const cmd = args[0];
                if (cmd === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "feature/no-upstream\n", stderr: "" };
                if (cmd === "config") return { stdout: "", stderr: "" };
                if (cmd === "rev-parse") return { stdout: "/tmp/pizzapi-test\n", stderr: "" };
                if (cmd === "status") return { stdout: "", stderr: "" };
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_pull",
            requestId: "pull-missing-upstream",
            payload: { cwd: "/tmp/pizzapi-test" },
        });
        const result = await waitForResult(socket, "pull-missing-upstream", "git_pull_result");
        expect(result.payload).toMatchObject({ ok: false, reason: "missingUpstream", branch: "feature/no-upstream" });
        expect(gitCalls.some((call) => call[0] === "fetch")).toBe(false);
    });

    test("pull fails with ambiguousUpstream when multiple merge targets exist", async () => {
        const service = new GitService({
            execGit: async (args) => {
                const cmd = args[0];
                if (cmd === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "feature/multi\n", stderr: "" };
                if (cmd === "config" && args[2] === "branch.feature/multi.remote") return { stdout: "origin\n", stderr: "" };
                if (cmd === "config" && args[2] === "branch.feature/multi.merge") {
                    return { stdout: "refs/heads/main\nrefs/heads/release\n", stderr: "" };
                }
                if (cmd === "rev-parse") return { stdout: "/tmp/pizzapi-test\n", stderr: "" };
                if (cmd === "status") return { stdout: "", stderr: "" };
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_pull",
            requestId: "pull-ambiguous-upstream",
            payload: { cwd: "/tmp/pizzapi-test" },
        });
        const result = await waitForResult(socket, "pull-ambiguous-upstream", "git_pull_result");
        expect(result.payload).toMatchObject({
            ok: false,
            reason: "ambiguousUpstream",
            branch: "feature/multi",
            mergeBranches: ["refs/heads/main", "refs/heads/release"],
        });
    });

    test("pull fails with detachedHead when no branch is checked out", async () => {
        const service = new GitService({
            execGit: async (args) => {
                const cmd = args[0];
                if (cmd === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "HEAD\n", stderr: "" };
                if (cmd === "rev-parse") return { stdout: "/tmp/pizzapi-test\n", stderr: "" };
                if (cmd === "status") return { stdout: "", stderr: "" };
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_pull",
            requestId: "pull-detached",
            payload: { cwd: "/tmp/pizzapi-test" },
        });
        const result = await waitForResult(socket, "pull-detached", "git_pull_result");
        expect(result.payload).toMatchObject({ ok: false, reason: "detachedHead" });
    });

    test("set_upstream configures the current branch tracking ref", async () => {
        const gitCalls: string[][] = [];

        const service = new GitService({
            execGit: async (args) => {
                gitCalls.push([...args]);
                const cmd = args[0];
                if (cmd === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "feature/test\n", stderr: "" };
                if (cmd === "branch" && args[1] === "--set-upstream-to=origin/main") return { stdout: "", stderr: "" };
                if (cmd === "rev-parse") return { stdout: "/tmp/pizzapi-test\n", stderr: "" };
                if (cmd === "status") return { stdout: "", stderr: "" };
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_set_upstream",
            requestId: "set-upstream-1",
            payload: { cwd: "/tmp/pizzapi-test", remote: "origin", branch: "main" },
        });
        const result = await waitForResult(socket, "set-upstream-1", "git_set_upstream_result");
        expect((result.payload as any).ok).toBe(true);
        expect(gitCalls).toContainEqual(["branch", "--set-upstream-to=origin/main", "feature/test"]);
    });

    test("pull conflict returns structured reason and invalidates cached status", async () => {
        const cwd = "/tmp/pizzapi-test";
        let statusCalls = 0;

        const service = new GitService({
            execGit: async (args) => {
                const cmd = args[0];
                if (cmd === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "" };
                if (cmd === "rev-parse") return { stdout: `${cwd}\n`, stderr: "" };
                if (cmd === "config" && args[2] === "branch.main.remote") return { stdout: "origin\n", stderr: "" };
                if (cmd === "config" && args[2] === "branch.main.merge") return { stdout: "refs/heads/main\n", stderr: "" };
                if (cmd === "fetch") return { stdout: "", stderr: "" };
                if (cmd === "rebase") throw new Error("CONFLICT (content): Merge conflict in src/app.ts");
                if (cmd === "status") {
                    statusCalls++;
                    return { stdout: ` M conflict-${statusCalls}.ts\0`, stderr: "" };
                }
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_status",
            requestId: "status-before-conflict",
            payload: { cwd },
        });
        await waitForResult(socket, "status-before-conflict", "git_status_result");
        expect(statusCalls).toBe(1);

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_pull",
            requestId: "pull-conflict",
            payload: { cwd },
        });
        const conflictResult = await waitForResult(socket, "pull-conflict", "git_pull_result");
        expect(conflictResult.payload).toMatchObject({ ok: false, reason: "conflict" });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_status",
            requestId: "status-after-conflict",
            payload: { cwd },
        });
        await waitForResult(socket, "status-after-conflict", "git_status_result");
        expect(statusCalls).toBe(2);
    });

    test("merge conflict returns structured reason", async () => {
        const service = new GitService({
            execGit: async (args) => {
                const cmd = args[0];
                if (cmd === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "" };
                if (cmd === "rev-parse") return { stdout: "/tmp/pizzapi-test\n", stderr: "" };
                if (cmd === "merge") throw new Error("CONFLICT (content): Merge conflict in src/app.ts");
                if (cmd === "status") return { stdout: "", stderr: "" };
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_merge",
            requestId: "merge-conflict",
            payload: { cwd: "/tmp/pizzapi-test", branch: "feature-sync-menu" },
        });
        const result = await waitForResult(socket, "merge-conflict", "git_merge_result");
        expect(result.payload).toMatchObject({ ok: false, reason: "conflict" });
    });

    test("overlapping repo mutations wait for the lock, then time out with busy if the conflicting operation doesn't finish", async () => {
        let checkoutStarted = false;
        let releaseCheckout: () => void = () => {
            throw new Error("Expected checkout release function");
        };
        const checkoutGate = new Promise<void>((resolve) => {
            releaseCheckout = resolve;
        });

        // Advance simulated time rapidly so the wait loop times out quickly
        let fakeNow = 0;
        const service = new GitService({
            execGit: async (args, options) => {
                const cmd = args[0];
                if (cmd === "checkout") {
                    checkoutStarted = true;
                    await checkoutGate;
                    return { stdout: "", stderr: "" };
                }
                if (cmd === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "" };
                if (cmd === "rev-parse" && args[1] === "--show-toplevel") return { stdout: "/tmp/pizzapi-test\n", stderr: "" };
                if (cmd === "rev-parse") return { stdout: `${options.cwd}\n`, stderr: "" };
                if (cmd === "status") return { stdout: "", stderr: "" };
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                if (cmd === "config" && args[2] === "branch.main.remote") return { stdout: "origin\n", stderr: "" };
                if (cmd === "config" && args[2] === "branch.main.merge") return { stdout: "refs/heads/main\n", stderr: "" };
                if (cmd === "fetch") return { stdout: "", stderr: "" };
                if (cmd === "rebase") return { stdout: "", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
            setTimeoutFn: (cb, ms) => {
                // Advance fake time by the wait amount (simulates time passing)
                fakeNow += ms;
                return setTimeout(cb, 0);
            },
            clearTimeoutFn: clearTimeout,
            now: () => fakeNow,
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_checkout",
            requestId: "checkout-busy-1",
            payload: { cwd: "/tmp/pizzapi-test/packages/ui", branch: "main", isRemote: false },
        });

        await waitForCondition(() => checkoutStarted);

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_pull",
            requestId: "pull-busy-1",
            payload: { cwd: "/tmp/pizzapi-test" },
        });
        const busyResult = await waitForResult(socket, "pull-busy-1", "git_pull_result");
        // Should eventually get busy error after waiting times out
        expect(busyResult.payload).toMatchObject({ ok: false, reason: "busy" });

        releaseCheckout();
        const checkoutResult = await waitForResult(socket, "checkout-busy-1", "git_checkout_result");
        expect((checkoutResult.payload as any).ok).toBe(true);
    });

    test("merge uses end-of-options separator", async () => {
        const gitCalls: string[][] = [];

        const service = new GitService({
            execGit: async (args) => {
                gitCalls.push([...args]);
                const cmd = args[0];
                if (cmd === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "" };
                if (cmd === "rev-parse") return { stdout: "/tmp/pizzapi-test\n", stderr: "" };
                if (cmd === "merge") return { stdout: "merged\n", stderr: "" };
                if (cmd === "status") return { stdout: "", stderr: "" };
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_merge",
            requestId: "merge-1",
            payload: { cwd: "/tmp/pizzapi-test", branch: "feature-sync-menu" },
        });
        const r = await waitForResult(socket, "merge-1", "git_merge_result");
        expect((r.payload as any).ok).toBe(true);
        expect(gitCalls.some((c) => c[0] === "merge" && c[1] === "--" && c[2] === "feature-sync-menu")).toBe(true);
    });
});

describe("GitService rebase", () => {
    test("rebase onto a branch", async () => {
        const gitCalls: string[][] = [];

        const service = new GitService({
            execGit: async (args) => {
                gitCalls.push([...args]);
                const cmd = args[0];
                if (cmd === "rebase" && args[1] === "--") return { stdout: "Rebased onto main\n", stderr: "" };
                if (cmd === "rev-parse") return { stdout: "/tmp/pizzapi-test\n", stderr: "" };
                if (cmd === "status") return { stdout: "", stderr: "" };
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_rebase",
            requestId: "rebase-1",
            payload: { cwd: "/tmp/pizzapi-test", branch: "main" },
        });
        const r = await waitForResult(socket, "rebase-1", "git_rebase_result");
        expect((r.payload as any).ok).toBe(true);
        expect(gitCalls.some((c) => c[0] === "rebase" && c[1] === "--" && c[2] === "main")).toBe(true);
    });

    test("rebase conflict returns structured reason", async () => {
        const service = new GitService({
            execGit: async (args) => {
                const cmd = args[0];
                if (cmd === "rebase") throw new Error("CONFLICT (content): Merge conflict in file.ts");
                if (cmd === "rev-parse") return { stdout: "/tmp/pizzapi-test\n", stderr: "" };
                if (cmd === "status") return { stdout: "", stderr: "" };
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_rebase",
            requestId: "rebase-conflict-1",
            payload: { cwd: "/tmp/pizzapi-test", branch: "main" },
        });
        const r = await waitForResult(socket, "rebase-conflict-1", "git_rebase_result");
        expect((r.payload as any).ok).toBe(false);
        expect((r.payload as any).reason).toBe("conflict");
    });

    test("rebase abort", async () => {
        const gitCalls: string[][] = [];

        const service = new GitService({
            execGit: async (args) => {
                gitCalls.push([...args]);
                const cmd = args[0];
                if (cmd === "rebase" && args[1] === "--abort") return { stdout: "", stderr: "" };
                if (cmd === "rev-parse") return { stdout: "/tmp/pizzapi-test\n", stderr: "" };
                if (cmd === "status") return { stdout: "", stderr: "" };
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_rebase_abort",
            requestId: "rebase-abort-1",
            payload: { cwd: "/tmp/pizzapi-test" },
        });
        const r = await waitForResult(socket, "rebase-abort-1", "git_rebase_abort_result");
        expect((r.payload as any).ok).toBe(true);
        expect(gitCalls.some((c) => c[0] === "rebase" && c[1] === "--abort")).toBe(true);
    });

    test("rebase continue", async () => {
        const gitCalls: string[][] = [];

        const service = new GitService({
            execGit: async (args) => {
                gitCalls.push([...args]);
                const cmd = args[0];
                if (cmd === "rebase" && args[1] === "--continue") return { stdout: "", stderr: "" };
                if (cmd === "rev-parse") return { stdout: "/tmp/pizzapi-test\n", stderr: "" };
                if (cmd === "status") return { stdout: "", stderr: "" };
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_rebase_continue",
            requestId: "rebase-continue-1",
            payload: { cwd: "/tmp/pizzapi-test" },
        });
        const r = await waitForResult(socket, "rebase-continue-1", "git_rebase_continue_result");
        expect((r.payload as any).ok).toBe(true);
        expect(gitCalls.some((c) => c[0] === "rebase" && c[1] === "--continue")).toBe(true);
    });
});

describe("GitService worktree add/remove", () => {
    test("worktree add with new branch", async () => {
        const gitCalls: string[][] = [];

        const service = new GitService({
            execGit: async (args) => {
                gitCalls.push([...args]);
                const cmd = args[0];
                if (cmd === "rev-parse" && args[1] === "--verify") throw new Error("not found");
                if (cmd === "worktree" && args[1] === "add") return { stdout: "", stderr: "" };
                if (cmd === "rev-parse") return { stdout: "/tmp/pizzapi-test\n", stderr: "" };
                if (cmd === "status") return { stdout: "", stderr: "" };
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_worktree_add",
            requestId: "wt-add-1",
            payload: { cwd: "/tmp/pizzapi-test", branch: "feat/new-thing", path: ".worktrees/new-thing" },
        });
        const r = await waitForResult(socket, "wt-add-1", "git_worktree_add_result");
        expect((r.payload as any).ok).toBe(true);
        expect((r.payload as any).branch).toBe("feat/new-thing");
        // Should use -b since branch doesn't exist yet
        expect(gitCalls.some((c) => c[0] === "worktree" && c[1] === "add" && c[2] === "-b")).toBe(true);
    });

    test("worktree add with existing branch", async () => {
        const gitCalls: string[][] = [];

        const service = new GitService({
            execGit: async (args) => {
                gitCalls.push([...args]);
                const cmd = args[0];
                if (cmd === "rev-parse" && args[1] === "--verify") return { stdout: "abc123\n", stderr: "" };
                if (cmd === "worktree" && args[1] === "add") return { stdout: "", stderr: "" };
                if (cmd === "rev-parse") return { stdout: "/tmp/pizzapi-test\n", stderr: "" };
                if (cmd === "status") return { stdout: "", stderr: "" };
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_worktree_add",
            requestId: "wt-add-2",
            payload: { cwd: "/tmp/pizzapi-test", branch: "main", path: ".worktrees/main" },
        });
        const r = await waitForResult(socket, "wt-add-2", "git_worktree_add_result");
        expect((r.payload as any).ok).toBe(true);
        // Should NOT use -b since branch already exists
        expect(gitCalls.some((c) => c[0] === "worktree" && c[1] === "add" && c[2] === "-b")).toBe(false);
    });

    test("worktree remove", async () => {
        const gitCalls: string[][] = [];

        const service = new GitService({
            execGit: async (args) => {
                gitCalls.push([...args]);
                const cmd = args[0];
                if (cmd === "worktree" && args[1] === "list") return { stdout: "worktree /tmp/pizzapi-test\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/pizzapi-test/.worktrees/feat\nHEAD def\nbranch refs/heads/feat\n", stderr: "" };
                if (cmd === "worktree" && args[1] === "remove") return { stdout: "", stderr: "" };
                if (cmd === "rev-parse") return { stdout: "/tmp/pizzapi-test\n", stderr: "" };
                if (cmd === "status") return { stdout: "", stderr: "" };
                if (cmd === "diff") return { stdout: "", stderr: "" };
                if (cmd === "rev-list") return { stdout: "0 0\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_worktree_remove",
            requestId: "wt-remove-1",
            payload: { cwd: "/tmp/pizzapi-test", path: "/tmp/pizzapi-test/.worktrees/feat" },
        });
        const r = await waitForResult(socket, "wt-remove-1", "git_worktree_remove_result");
        expect((r.payload as any).ok).toBe(true);
        expect(gitCalls.some((c) => c[0] === "worktree" && c[1] === "remove")).toBe(true);
    });

    test("worktree remove rejects unknown paths", async () => {
        const service = new GitService({
            execGit: async (args) => {
                const cmd = args[0];
                if (cmd === "worktree" && args[1] === "list") return { stdout: "worktree /tmp/pizzapi-test\nHEAD abc\nbranch refs/heads/main\n", stderr: "" };
                if (cmd === "rev-parse") return { stdout: "/tmp/pizzapi-test\n", stderr: "" };
                throw new Error(`Unexpected git args: ${args.join(" ")}`);
            },
        });

        const socket = createMockSocket();
        service.init(socket as any, { isShuttingDown: () => false });

        dispatchServiceMessage(socket, {
            serviceId: "git",
            type: "git_worktree_remove",
            requestId: "wt-remove-2",
            payload: { cwd: "/tmp/pizzapi-test", path: "/unknown/path" },
        });
        const r = await waitForResult(socket, "wt-remove-2", "git_worktree_remove_result");
        expect((r.payload as any).ok).toBe(false);
        expect((r.payload as any).message).toContain("not a known git worktree");
    });
});
