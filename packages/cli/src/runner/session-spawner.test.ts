import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("session-spawner", () => {
    test("spawns workers with the expected env, handles restart/cleanup, and guards killed sessions from re-spawn", () => {
        const tmpHome = mkdtempSync(join(tmpdir(), "session-spawner-test-"));
        const childTestPath = join(import.meta.dir, `.session-spawner-child-${Date.now()}-${Math.random().toString(16).slice(2)}.test.ts`);

        // Use the packages/cli directory as the cwd so bun picks up its local
        // bunfig.toml (root="./src", no preload) instead of the root bunfig.toml
        // which has a redis preload that fails in isolated test runs.
        const cliDir = join(import.meta.dir, "../../..");

        try {
            writeFileSync(
                childTestPath,
                `
import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class FakeChild extends EventEmitter {
    pid = 4321;
    killed = false;
    exitCode: number | null = null;
}

describe("session-spawner child", () => {
    test("covers spawn env, restart handling, and cleanup", async () => {
        const cleanupSessionAttachments = mock(async (_sessionId: string) => {});
        const logInfo = mock((_message: string) => {});
        const trackSessionCwd = mock((_sessionId: string, _cwd: string) => {});
        const untrackSessionCwd = mock((_sessionId: string, _cwd: string) => {});
        const runnerUsageCacheFilePath = mock(() => "/tmp/test-usage-cache.json");
        let allowCwd = true;
        const isCwdAllowed = mock((_cwd: string | undefined) => allowCwd);

        process.env.ANTHROPIC_API_KEY = "keep-me";
        process.env.PIZZAPI_RUNNER_TOKEN = "runner-secret";
        process.env.PIZZAPI_RUNNER_API_KEY = "daemon-secret";
        process.env.NODE_OPTIONS = "--require /tmp/pwned.js";
        process.env.BUN_OPTIONS = "--preload /tmp/pwned.ts";
        process.env.LD_PRELOAD = "/tmp/pwned.so";

        let latestChild: FakeChild | null = null;
        let lastSpawnCall:
            | { execPath: string; args: string[]; stdio: string[]; env: Record<string, string> }
            | undefined;

        const spawnMock = mock((execPath: string, args: string[], options: { stdio: string[]; env: Record<string, string> }) => {
            latestChild = new FakeChild();
            lastSpawnCall = {
                execPath,
                args,
                stdio: options.stdio,
                env: options.env,
            };
            return latestChild;
        });

        mock.module("node:child_process", () => ({
            spawn: spawnMock,
        }));

        mock.module("../extensions/session-attachments.js", () => ({
            cleanupSessionAttachments,
        }));

        mock.module("./logger.js", () => ({
            logInfo,
        }));

        mock.module("./runner-usage-cache.js", () => ({
            runnerUsageCacheFilePath,
            trackSessionCwd,
            untrackSessionCwd,
        }));

        mock.module("./workspace.js", () => ({
            isCwdAllowed,
        }));

        const { spawnSession } = await import("./session-spawner.js");
        const tempCwd = mkdtempSync(join(tmpdir(), "session-spawner-child-"));

        try {
            const runningSessions = new Map();
            const restartingSessions = new Set<string>();
            const killedSessions = new Set<string>();

            spawnSession(
                "sess-main",
                "api-key",
                "https://relay.example",
                tempCwd,
                runningSessions,
                restartingSessions,
                killedSessions,
                undefined,
                {
                    prompt: "hello",
                    model: { provider: "anthropic", id: "claude-sonnet" },
                    hiddenModels: ["anthropic/claude-opus"],
                    agent: {
                        name: "researcher",
                        systemPrompt: "system",
                        tools: "read,bash",
                        disallowedTools: "write",
                    },
                    parentSessionId: "parent-1",
                    autoClose: true,
                },
            );

            expect(lastSpawnCall?.execPath).toBe(process.execPath);
            expect(lastSpawnCall?.args.length).toBeGreaterThan(0);
            expect(lastSpawnCall?.stdio).toEqual(["ignore", "inherit", "inherit", "ipc"]);
            expect(lastSpawnCall?.env).toMatchObject({
                ANTHROPIC_API_KEY: "keep-me",
                PIZZAPI_RELAY_URL: "https://relay.example",
                PIZZAPI_API_KEY: "api-key",
                PIZZAPI_SESSION_ID: "sess-main",
                PIZZAPI_WORKER_CWD: tempCwd,
                PIZZAPI_RUNNER_USAGE_CACHE_PATH: "/tmp/test-usage-cache.json",
                PIZZAPI_WORKER_INITIAL_PROMPT: "hello",
                PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER: "anthropic",
                PIZZAPI_WORKER_INITIAL_MODEL_ID: "claude-sonnet",
                PIZZAPI_HIDDEN_MODELS: JSON.stringify(["anthropic/claude-opus"]),
                PIZZAPI_WORKER_PARENT_SESSION_ID: "parent-1",
                PIZZAPI_WORKER_AGENT_NAME: "researcher",
                PIZZAPI_WORKER_AGENT_SYSTEM_PROMPT: "system",
                PIZZAPI_WORKER_AGENT_TOOLS: "read,bash",
                PIZZAPI_WORKER_AGENT_DISALLOWED_TOOLS: "write",
                PIZZAPI_WORKER_AUTO_CLOSE: "true",
            });
            expect(lastSpawnCall?.env.PIZZAPI_RUNNER_TOKEN).toBeUndefined();
            expect(lastSpawnCall?.env.PIZZAPI_RUNNER_API_KEY).toBeUndefined();
            expect(lastSpawnCall?.env.NODE_OPTIONS).toBeUndefined();
            expect(lastSpawnCall?.env.BUN_OPTIONS).toBeUndefined();
            expect(lastSpawnCall?.env.LD_PRELOAD).toBeUndefined();
            expect(trackSessionCwd).toHaveBeenCalledWith("sess-main", tempCwd);
            expect(runningSessions.get("sess-main")).toMatchObject({
                sessionId: "sess-main",
                child: latestChild,
                parentSessionId: "parent-1",
            });

            latestChild!.emit("message", { type: "pre_restart" });
            expect(restartingSessions.has("sess-main")).toBe(true);

            const restartRunningSessions = new Map();
            const restartRestartingSessions = new Set<string>();
            const restartKilledSessions = new Set<string>();
            const onRestartRequested = mock(() => {});
            spawnSession(
                "sess-restart",
                "api-key",
                "https://relay.example",
                tempCwd,
                restartRunningSessions,
                restartRestartingSessions,
                restartKilledSessions,
                onRestartRequested,
            );
            latestChild!.exitCode = 43;
            latestChild!.emit("exit", 43, null);
            await Promise.resolve();
            expect(onRestartRequested).toHaveBeenCalledTimes(1);
            expect(restartRestartingSessions.has("sess-restart")).toBe(true);
            expect(restartRunningSessions.has("sess-restart")).toBe(false);
            expect(untrackSessionCwd).toHaveBeenCalledWith("sess-restart", tempCwd);
            expect(cleanupSessionAttachments).not.toHaveBeenCalled();

            const normalRunningSessions = new Map();
            const normalRestartingSessions = new Set<string>();
            const normalKilledSessions = new Set<string>();
            spawnSession("sess-exit", "api-key", "https://relay.example", tempCwd, normalRunningSessions, normalRestartingSessions, normalKilledSessions);
            latestChild!.exitCode = 0;
            latestChild!.emit("exit", 0, null);
            await Promise.resolve();
            expect(normalRunningSessions.has("sess-exit")).toBe(false);
            expect(cleanupSessionAttachments).toHaveBeenCalledWith("sess-exit");

            allowCwd = false;
            expect(() =>
                spawnSession("sess-bad", "api-key", "https://relay.example", tempCwd, new Map(), new Set(), new Set()),
            ).toThrow("Requested cwd is outside allowed workspace root(s): " + tempCwd);
        } finally {
            rmSync(tempCwd, { recursive: true, force: true });
        }
    });

    test("killed session with exit code 43 does not re-spawn (race condition guard)", async () => {
        const cleanupSessionAttachments = mock(async (_sessionId: string) => {});
        const logInfo = mock((_message: string) => {});
        const trackSessionCwd = mock((_sessionId: string, _cwd: string) => {});
        const untrackSessionCwd = mock((_sessionId: string, _cwd: string) => {});
        const runnerUsageCacheFilePath = mock(() => "/tmp/test-usage-cache.json");
        const isCwdAllowed = mock((_cwd: string | undefined) => true);

        let latestChild: FakeChild | null = null;

        const spawnMock = mock((_execPath: string, _args: string[], _options: { stdio: string[]; env: Record<string, string> }) => {
            latestChild = new FakeChild();
            return latestChild;
        });

        mock.module("node:child_process", () => ({
            spawn: spawnMock,
        }));

        mock.module("../extensions/session-attachments.js", () => ({
            cleanupSessionAttachments,
        }));

        mock.module("./logger.js", () => ({
            logInfo,
        }));

        mock.module("./runner-usage-cache.js", () => ({
            runnerUsageCacheFilePath,
            trackSessionCwd,
            untrackSessionCwd,
        }));

        mock.module("./workspace.js", () => ({
            isCwdAllowed,
        }));

        const { spawnSession } = await import("./session-spawner.js");
        const tempCwd = mkdtempSync(join(tmpdir(), "session-spawner-killed-race-"));

        try {
            const runningSessions = new Map();
            const restartingSessions = new Set<string>();
            const killedSessions = new Set<string>();
            const onRestartRequested = mock(() => {});

            spawnSession(
                "sess-killed-race",
                "api-key",
                "https://relay.example",
                tempCwd,
                runningSessions,
                restartingSessions,
                killedSessions,
                onRestartRequested,
            );

            // Simulate kill_session: daemon marks session as killed before SIGTERM
            killedSessions.add("sess-killed-race");

            // Race: worker exits with code 43 (restart-in-place) before SIGTERM arrives
            latestChild!.exitCode = 43;
            latestChild!.emit("exit", 43, null);
            await Promise.resolve();

            // Guard must prevent re-spawning for an explicitly killed session
            expect(onRestartRequested).not.toHaveBeenCalled();
            // Should clean up attachments (treated as true termination, not restart)
            expect(cleanupSessionAttachments).toHaveBeenCalledWith("sess-killed-race");
            // killedSessions entry must be removed to prevent set growth
            expect(killedSessions.has("sess-killed-race")).toBe(false);
            // Session must be removed from runningSessions
            expect(runningSessions.has("sess-killed-race")).toBe(false);
        } finally {
            rmSync(tempCwd, { recursive: true, force: true });
        }
    });
});
`,
            );

            execFileSync(process.execPath, ["test", childTestPath], {
                cwd: cliDir,
                encoding: "utf-8",
                env: {
                    ...process.env,
                    HOME: tmpHome,
                },
                stdio: ["ignore", "pipe", "pipe"],
            });

            expect(true).toBe(true);
        } finally {
            rmSync(childTestPath, { force: true });
            rmSync(tmpHome, { recursive: true, force: true });
        }
    });
});
