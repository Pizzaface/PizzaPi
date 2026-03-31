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
                if (cmd === "pull" || cmd === "push") return { stdout: "ok", stderr: "" };
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
