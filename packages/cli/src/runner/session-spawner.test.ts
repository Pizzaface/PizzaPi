import { describe, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realChildProcessNs from "node:child_process";

const realChildProcess = { ...realChildProcessNs };

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
import { describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realChildProcessNs from "node:child_process";

// Snapshot the real module so mocks only replace what the spawner uses;
// transitive imports (e.g. @pizzapi/tools) still need the other exports.
const realChildProcess = { ...realChildProcessNs };

class FakeChild extends EventEmitter {
    pid = 4321;
    killed = false;
    exitCode: number | null = null;
}

const recordedGroupPids: number[] = [];
mock.module("./session-procs.js", () => ({
    ensureSessionProcDir: () => {},
    sessionProcFilePath: (_sessionId: string) => "/tmp/test-session.procs",
    readRecordedGroupPids: () => recordedGroupPids,
    recordSessionGroupPid: () => {},
    removeSessionProcFile: () => {},
}));

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
        // Docker/K8s secret pointers already expanded by the CLI entrypoint (review R1).
        process.env.PIZZAPI_API_KEY_FILE = "/run/secrets/pizzapi_api_key";
        process.env.PIZZAPI_RUNNER_TOKEN_FILE = "/run/secrets/runner_token";
        process.env.PIZZAPI_RUNNER_API_KEY_FILE = "/run/secrets/runner_api_key";
        process.env.GH_TOKEN_FILE = "/run/secrets/gh";

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

        mock.module("node:child_process", () => ({ ...realChildProcess,
            spawn: spawnMock,
            execFile: mock(() => {}),
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
            refreshAndWriteRunnerUsageCache: mock(async () => {}),
        }));

        mock.module("./workspace.js", () => ({
            isCwdAllowed,
        }));

        mock.module("../config.js", () => ({
            loadConfig: () => ({
                envOverrides: {
                    PIZZAPI_NO_MCP: "1",
                    PIZZAPI_RELAY_URL: "ignored",
                    ANTHROPIC_API_KEY: "ignored",
                    NODE_OPTIONS: "ignored",
                    PIZZAPI_RUNNER_TOKEN_FILE: "/tmp/override-pointer",
                },
            }),
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
                    imageUrls: ["https://cdn.discordapp.com/a.png"],
                    model: { provider: "anthropic", id: "claude-sonnet" },
                    effort: "high",
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
                PIZZAPI_NO_MCP: "1",
                PIZZAPI_RELAY_URL: "https://relay.example",
                PIZZAPI_API_KEY: "api-key",
                PIZZAPI_SESSION_ID: "sess-main",
                PIZZAPI_WORKER_CWD: tempCwd,
                PIZZAPI_RUNNER_USAGE_CACHE_PATH: "/tmp/test-usage-cache.json",
                PIZZAPI_WORKER_INITIAL_PROMPT: "hello",
                PIZZAPI_WORKER_INITIAL_IMAGE_URLS: JSON.stringify(["https://cdn.discordapp.com/a.png"]),
                PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER: "anthropic",
                PIZZAPI_WORKER_INITIAL_MODEL_ID: "claude-sonnet",
                PIZZAPI_WORKER_INITIAL_EFFORT: "high",
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
            expect(lastSpawnCall?.env.PIZZAPI_API_KEY_FILE).toBeUndefined();
            expect(lastSpawnCall?.env.PIZZAPI_RUNNER_TOKEN_FILE).toBeUndefined();
            expect(lastSpawnCall?.env.PIZZAPI_RUNNER_API_KEY_FILE).toBeUndefined();
            expect(lastSpawnCall?.env.GH_TOKEN_FILE).toBe("/run/secrets/gh");
            expect(isCwdAllowed).toHaveBeenCalledWith(tempCwd);
            expect(trackSessionCwd).toHaveBeenCalledWith("sess-main", tempCwd);
            expect(runningSessions.get("sess-main")).toMatchObject({
                sessionId: "sess-main",
                child: latestChild,
                parentSessionId: "parent-1",
            });

            latestChild!.emit("message", { type: "session_metadata", sessionFile: "/tmp/sess-main.jsonl" });
            expect(runningSessions.get("sess-main")?.sessionFile).toBe("/tmp/sess-main.jsonl");

            latestChild!.emit("message", { type: "pre_restart" });
            expect(restartingSessions.has("sess-main")).toBe(true);

            const restartRunningSessions = new Map();
            const restartRestartingSessions = new Set<string>();
            const restartKilledSessions = new Set<string>();
            const onRestartRequested = mock(() => {});
            const onSessionExitRestart = mock((_sessionId: string) => {});
            spawnSession(
                "sess-restart",
                "api-key",
                "https://relay.example",
                tempCwd,
                restartRunningSessions,
                restartRestartingSessions,
                restartKilledSessions,
                onRestartRequested,
                { onSessionExit: onSessionExitRestart },
            );
            latestChild!.exitCode = 43;
            latestChild!.emit("exit", 43, null);
            await Promise.resolve();
            expect(onRestartRequested).toHaveBeenCalledTimes(1);
            expect(restartRestartingSessions.has("sess-restart")).toBe(true);
            expect(restartRunningSessions.has("sess-restart")).toBe(false);
            expect(untrackSessionCwd).toHaveBeenCalledWith("sess-restart", tempCwd);
            expect(cleanupSessionAttachments).not.toHaveBeenCalled();
            // Restart-in-place is NOT a session end — service cleanup must not run.
            expect(onSessionExitRestart).not.toHaveBeenCalled();

            const normalRunningSessions = new Map();
            const normalRestartingSessions = new Set<string>();
            const normalKilledSessions = new Set<string>();
            // Daemon-owned worker-exit cleanup: fires on true termination even
            // with no relay session_ended, and a throwing hook never crashes the
            // exit handler.
            const onSessionExit = mock((_sessionId: string) => {
                throw new Error("cleanup boom");
            });
            spawnSession("sess-exit", "api-key", "https://relay.example", tempCwd, normalRunningSessions, normalRestartingSessions, normalKilledSessions, undefined, { onSessionExit });
            latestChild!.emit("message", { type: "pre_restart" });
            expect(normalRestartingSessions.has("sess-exit")).toBe(true);
            latestChild!.exitCode = 0;
            latestChild!.emit("exit", 0, null);
            await Promise.resolve();
            expect(normalRunningSessions.has("sess-exit")).toBe(false);
            expect(normalRestartingSessions.has("sess-exit")).toBe(false);
            expect(cleanupSessionAttachments).toHaveBeenCalledWith("sess-exit");
            expect(onSessionExit).toHaveBeenCalledWith("sess-exit");
            expect(onSessionExit).toHaveBeenCalledTimes(1);

            allowCwd = false;
            expect(() =>
                spawnSession("sess-default-bad", "api-key", "https://relay.example", undefined, new Map(), new Set(), new Set()),
            ).toThrow("Requested cwd is outside allowed workspace root(s): " + process.cwd());
            expect(isCwdAllowed).toHaveBeenLastCalledWith(process.cwd());
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

        mock.module("node:child_process", () => ({ ...realChildProcess,
            spawn: spawnMock,
            execFile: mock(() => {}),
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
            refreshAndWriteRunnerUsageCache: mock(async () => {}),
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

    test("natural exit escalates SIGTERM to SIGKILL for recorded command groups after grace", async () => {
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

        mock.module("node:child_process", () => ({ ...realChildProcess,
            spawn: spawnMock,
            execFile: mock(() => {}),
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
            refreshAndWriteRunnerUsageCache: mock(async () => {}),
        }));

        mock.module("./workspace.js", () => ({
            isCwdAllowed,
        }));

        mock.module("./session-procs.js", () => ({
            ensureSessionProcDir: () => {},
            sessionProcFilePath: (_sessionId: string) => "/tmp/test-session.procs",
            readRecordedGroupPids: () => recordedGroupPids,
            recordSessionGroupPid: () => {},
            removeSessionProcFile: () => {},
        }));

        mock.module("../config.js", () => ({
            loadConfig: () => ({ envOverrides: {} }),
        }));

        const { spawnSession } = await import("./session-spawner.js");
        const tempCwd = mkdtempSync(join(tmpdir(), "session-spawner-sigkill-"));

        const signals: { pid: number; signal?: string | number }[] = [];
        // spy succeeds for all calls (probe signal 0 does not throw → group alive)
        const killSpy = spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
            signals.push({ pid, signal });
            return true;
        });

        try {
            const runningSessions = new Map();
            const restartingSessions = new Set<string>();
            const killedSessions = new Set<string>();
            recordedGroupPids.length = 0;
            recordedGroupPids.push(5678);

            spawnSession(
                "sess-sigkill",
                "api-key",
                "https://relay.example",
                tempCwd,
                runningSessions,
                restartingSessions,
                killedSessions,
                undefined,
                { shutdownGraceMs: 30 },
            );

            latestChild!.exitCode = 0;
            latestChild!.emit("exit", 0, null);
            await Promise.resolve();

            // Initial natural-exit cleanup sends SIGTERM to the worker process
            // group and each recorded command group.
            const termSignals = signals.filter((s) => s.signal === "SIGTERM" || s.signal === undefined);
            expect(termSignals).toContainEqual({ pid: -4321, signal: "SIGTERM" });
            expect(termSignals).toContainEqual({ pid: -5678, signal: "SIGTERM" });
            expect(signals.some((s) => s.signal === "SIGKILL")).toBe(false);

            // After the grace period, liveness probes (signal 0) confirm groups
            // are alive (spy does not throw), so SIGKILL is sent to both.
            await new Promise((resolve) => setTimeout(resolve, 80));
            expect(signals).toContainEqual({ pid: -4321, signal: 0 }); // probe
            expect(signals).toContainEqual({ pid: -5678, signal: 0 }); // probe
            expect(signals.filter((s) => s.signal === "SIGKILL")).toContainEqual({ pid: -4321, signal: "SIGKILL" });
            expect(signals.filter((s) => s.signal === "SIGKILL")).toContainEqual({ pid: -5678, signal: "SIGKILL" });
            expect(logInfo).toHaveBeenCalledWith(expect.stringContaining("force-killed remaining groups after 30ms"));
        } finally {
            killSpy.mockRestore();
            rmSync(tempCwd, { recursive: true, force: true });
        }
    });

    test("natural exit skips SIGKILL when process group is already dead (ESRCH probe)", async () => {
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

        mock.module("node:child_process", () => ({ ...realChildProcess,
            spawn: spawnMock,
            execFile: mock(() => {}),
        }));
        mock.module("../extensions/session-attachments.js", () => ({ cleanupSessionAttachments }));
        mock.module("./logger.js", () => ({ logInfo }));
        mock.module("./runner-usage-cache.js", () => ({ runnerUsageCacheFilePath, trackSessionCwd, untrackSessionCwd, refreshAndWriteRunnerUsageCache: mock(async () => {}) }));
        mock.module("./workspace.js", () => ({ isCwdAllowed }));
        mock.module("./session-procs.js", () => ({
            ensureSessionProcDir: () => {},
            sessionProcFilePath: () => "/tmp/test-session.procs",
            readRecordedGroupPids: () => recordedGroupPids,
            recordSessionGroupPid: () => {},
            removeSessionProcFile: () => {},
        }));
        mock.module("../config.js", () => ({ loadConfig: () => ({ envOverrides: {} }) }));

        const { spawnSession } = await import("./session-spawner.js");
        const tempCwd = mkdtempSync(join(tmpdir(), "session-spawner-esrch-"));

        const signals: { pid: number; signal?: string | number }[] = [];
        // Probe (signal 0) throws ESRCH → group already dead → SIGKILL must NOT be sent.
        const killSpy = spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
            if (signal === 0) {
                const err = Object.assign(new Error("No such process"), { code: "ESRCH" });
                throw err;
            }
            signals.push({ pid, signal });
            return true;
        });

        try {
            const runningSessions = new Map();
            recordedGroupPids.length = 0;
            recordedGroupPids.push(5678);

            spawnSession(
                "sess-esrch",
                "api-key",
                "https://relay.example",
                tempCwd,
                runningSessions,
                new Set(),
                new Set(),
                undefined,
                { shutdownGraceMs: 30 },
            );

            latestChild!.exitCode = 0;
            latestChild!.emit("exit", 0, null);
            await Promise.resolve();

            // After the grace period, probes throw ESRCH → no SIGKILL sent to any group.
            await new Promise((resolve) => setTimeout(resolve, 80));
            expect(signals.some((s) => s.signal === "SIGKILL")).toBe(false);
            // logInfo is still called (groups were probed; all were already gone)
            expect(logInfo).toHaveBeenCalledWith(expect.stringContaining("force-killed remaining groups after 30ms"));
        } finally {
            killSpy.mockRestore();
            rmSync(tempCwd, { recursive: true, force: true });
        }
    });

    test("natural exit falls back to forceKillTree when killSessionProcessGroup returns false", async () => {
        const cleanupSessionAttachments = mock(async (_sessionId: string) => {});
        const logInfo = mock((_message: string) => {});
        const trackSessionCwd = mock((_sessionId: string, _cwd: string) => {});
        const untrackSessionCwd = mock((_sessionId: string, _cwd: string) => {});
        const runnerUsageCacheFilePath = mock(() => "/tmp/test-usage-cache.json");
        const isCwdAllowed = mock((_cwd: string | undefined) => true);
        const forceKillTree = mock((_child: unknown) => {});

        let latestChild: FakeChild | null = null;
        const spawnMock = mock((_execPath: string, _args: string[], _options: { stdio: string[]; env: Record<string, string> }) => {
            latestChild = new FakeChild();
            return latestChild;
        });

        mock.module("node:child_process", () => ({ ...realChildProcess, spawn: spawnMock, execFile: mock(() => {}) }));
        mock.module("../extensions/session-attachments.js", () => ({ cleanupSessionAttachments }));
        mock.module("./logger.js", () => ({ logInfo }));
        mock.module("./runner-usage-cache.js", () => ({ runnerUsageCacheFilePath, trackSessionCwd, untrackSessionCwd, refreshAndWriteRunnerUsageCache: mock(async () => {}) }));
        mock.module("./workspace.js", () => ({ isCwdAllowed }));
        mock.module("./session-procs.js", () => ({
            ensureSessionProcDir: () => {},
            sessionProcFilePath: () => "/tmp/test-session.procs",
            readRecordedGroupPids: () => [],
            recordSessionGroupPid: () => {},
            removeSessionProcFile: () => {},
        }));
        mock.module("../config.js", () => ({ loadConfig: () => ({ envOverrides: {} }) }));
        mock.module("./process-kill.js", () => ({ forceKillTree }));

        const { spawnSession } = await import("./session-spawner.js");
        const tempCwd = mkdtempSync(join(tmpdir(), "session-spawner-ftree-"));

        const signals: { pid: number; signal?: string | number }[] = [];
        // Probe succeeds (alive), but SIGKILL to child.pid throws → killSessionProcessGroup returns false.
        const killSpy = spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
            if (signal === 0) return true; // probe: alive
            if (signal === "SIGKILL") {
                // Simulate group disappearing between probe and kill (or Windows path)
                const err = Object.assign(new Error("No such process"), { code: "ESRCH" });
                throw err;
            }
            signals.push({ pid, signal });
            return true;
        });

        try {
            const runningSessions = new Map();
            recordedGroupPids.length = 0; // no extra groups

            spawnSession(
                "sess-ftree",
                "api-key",
                "https://relay.example",
                tempCwd,
                runningSessions,
                new Set(),
                new Set(),
                undefined,
                { shutdownGraceMs: 30 },
            );

            latestChild!.exitCode = 0;
            latestChild!.emit("exit", 0, null);
            await Promise.resolve();

            await new Promise((resolve) => setTimeout(resolve, 80));
            // forceKillTree must be called as fallback when killSessionProcessGroup returns false
            expect(forceKillTree).toHaveBeenCalledWith(latestChild);
        } finally {
            killSpy.mockRestore();
            rmSync(tempCwd, { recursive: true, force: true });
        }
    });

    test("natural exit deduplicates groupPid equal to child.pid — no double SIGKILL", async () => {
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

        mock.module("node:child_process", () => ({ ...realChildProcess, spawn: spawnMock, execFile: mock(() => {}) }));
        mock.module("../extensions/session-attachments.js", () => ({ cleanupSessionAttachments }));
        mock.module("./logger.js", () => ({ logInfo }));
        mock.module("./runner-usage-cache.js", () => ({ runnerUsageCacheFilePath, trackSessionCwd, untrackSessionCwd, refreshAndWriteRunnerUsageCache: mock(async () => {}) }));
        mock.module("./workspace.js", () => ({ isCwdAllowed }));
        mock.module("./session-procs.js", () => ({
            ensureSessionProcDir: () => {},
            sessionProcFilePath: () => "/tmp/test-session.procs",
            // groupPids contains child.pid (4321) — should be deduplicated
            readRecordedGroupPids: () => [4321],
            recordSessionGroupPid: () => {},
            removeSessionProcFile: () => {},
        }));
        mock.module("../config.js", () => ({ loadConfig: () => ({ envOverrides: {} }) }));

        const { spawnSession } = await import("./session-spawner.js");
        const tempCwd = mkdtempSync(join(tmpdir(), "session-spawner-dedup-"));

        const signals: { pid: number; signal?: string | number }[] = [];
        const killSpy = spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
            signals.push({ pid, signal });
            return true;
        });

        try {
            spawnSession(
                "sess-dedup",
                "api-key",
                "https://relay.example",
                tempCwd,
                new Map(),
                new Set(),
                new Set(),
                undefined,
                { shutdownGraceMs: 30 },
            );

            latestChild!.exitCode = 0;
            latestChild!.emit("exit", 0, null);
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 80));

            // SIGKILL to -4321 must appear exactly once (dedup prevents double-kill)
            const sigkills = signals.filter((s) => s.signal === "SIGKILL" && s.pid === -4321);
            expect(sigkills).toHaveLength(1);
        } finally {
            killSpy.mockRestore();
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

    test("restart-in-place retains the prior worker process group and reaps it on final exit (F23)", async () => {
        const logInfo = mock((_message: string) => {});
        const isCwdAllowed = mock((_cwd: string | undefined) => true);

        class FakeChild extends EventEmitter {
            pid = 0;
            killed = false;
            exitCode: number | null = null;
        }

        let nextPid = 7001;
        let latestChild: FakeChild | null = null;
        const spawnMock = mock(() => {
            latestChild = new FakeChild();
            latestChild.pid = nextPid++;
            return latestChild;
        });

        // Simulated on-disk pid file shared across worker generations.
        const procFile: number[] = [];
        mock.module("node:child_process", () => ({ ...realChildProcess, spawn: spawnMock, execFile: mock(() => {}) }));
        mock.module("../extensions/session-attachments.js", () => ({ cleanupSessionAttachments: mock(async () => {}) }));
        mock.module("./logger.js", () => ({ logInfo }));
        mock.module("./runner-usage-cache.js", () => ({
            runnerUsageCacheFilePath: () => "/tmp/test-usage-cache.json",
            trackSessionCwd: () => {},
            untrackSessionCwd: () => {},
            refreshAndWriteRunnerUsageCache: mock(async () => {}),
        }));
        mock.module("./workspace.js", () => ({ isCwdAllowed }));
        mock.module("./session-procs.js", () => ({
            ensureSessionProcDir: () => {},
            sessionProcFilePath: () => "/tmp/test-session.procs",
            readRecordedGroupPids: () => [...new Set(procFile)],
            recordSessionGroupPid: (_file: string, pid: number) => { procFile.push(pid); },
            removeSessionProcFile: () => { procFile.length = 0; },
        }));
        mock.module("../config.js", () => ({ loadConfig: () => ({ envOverrides: {} }) }));

        const { spawnSession } = await import("./session-spawner.js");
        const tempCwd = mkdtempSync(join(tmpdir(), "session-spawner-restart-pgid-"));

        // Group 7001 keeps a live member (e.g. an MCP server that ignored pipe
        // closure); probes for every other group report ESRCH.
        const liveGroups = new Set([7001]);
        const signals: { pid: number; signal?: string | number }[] = [];
        const killSpy = spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
            if (signal === 0 && !liveGroups.has(-pid)) {
                throw Object.assign(new Error("No such process"), { code: "ESRCH" });
            }
            signals.push({ pid, signal });
            return true;
        });

        try {
            const runningSessions = new Map();
            const restartingSessions = new Set<string>();
            const killedSessions = new Set<string>();
            const respawn = () => spawnSession(
                "sess-gen", "api-key", "https://relay.example", tempCwd,
                runningSessions, restartingSessions, killedSessions, respawn, { shutdownGraceMs: 30 },
            );
            respawn();
            const gen1 = latestChild!;
            expect(gen1.pid).toBe(7001);

            // Generation 1 restarts in place: its group must NOT be signaled
            // (continuity), but must be recorded for later cleanup.
            gen1.exitCode = 43;
            gen1.emit("exit", 43, null);
            await Promise.resolve();
            expect(procFile).toEqual([7001]);
            expect(signals.some((s) => s.pid === -7001 && s.signal !== 0)).toBe(false);
            const gen2 = latestChild!;
            expect(gen2.pid).toBe(7002);

            // Generation 2 restarts too; its group is already empty, so it is
            // not recorded (avoids keeping a dead PGID that could be recycled).
            gen2.exitCode = 43;
            gen2.emit("exit", 43, null);
            await Promise.resolve();
            expect(procFile).toEqual([7001]);
            const gen3 = latestChild!;

            // Final termination reaps the historical group along with the
            // current worker's group: SIGTERM now, SIGKILL after the grace.
            gen3.exitCode = 0;
            gen3.emit("exit", 0, null);
            await Promise.resolve();
            expect(signals).toContainEqual({ pid: -7003, signal: "SIGTERM" });
            expect(signals).toContainEqual({ pid: -7001, signal: "SIGTERM" });
            await new Promise((resolve) => setTimeout(resolve, 80));
            expect(signals).toContainEqual({ pid: -7001, signal: "SIGKILL" });
            expect(procFile).toEqual([]);
        } finally {
            killSpy.mockRestore();
            rmSync(tempCwd, { recursive: true, force: true });
        }
    });

    test("handles refresh_usage_request IPC by forcing usage cache refresh and replying", async () => {
        const cleanupSessionAttachments = mock(async (_sessionId: string) => {});
        const logInfo = mock((_message: string) => {});
        const trackSessionCwd = mock((_sessionId: string, _cwd: string) => {});
        const untrackSessionCwd = mock((_sessionId: string, _cwd: string) => {});
        const runnerUsageCacheFilePath = mock(() => "/tmp/test-usage-cache.json");
        const refreshCalls: { forceAnthropic?: boolean }[] = [];
        const refreshAndWriteRunnerUsageCache = mock(async (opts: { forceAnthropic?: boolean } = {}) => {
            refreshCalls.push(opts);
        });
        const isCwdAllowed = mock((_cwd: string | undefined) => true);

        class FakeChild extends EventEmitter {
            pid = 4321;
            killed = false;
            exitCode: number | null = null;
            send = mock((_msg: unknown) => {});
        }

        const spawnMock = mock((_execPath: string, _args: string[], _options: any) => new FakeChild());

        mock.module("node:child_process", () => ({ ...realChildProcess,
            spawn: spawnMock,
            execFile: mock(() => {}),
        }));
        mock.module("../extensions/session-attachments.js", () => ({ cleanupSessionAttachments }));
        mock.module("./logger.js", () => ({ logInfo }));
        mock.module("./runner-usage-cache.js", () => ({
            runnerUsageCacheFilePath,
            trackSessionCwd,
            untrackSessionCwd,
            refreshAndWriteRunnerUsageCache,
        }));
        mock.module("./workspace.js", () => ({ isCwdAllowed }));

        const { spawnSession } = await import("./session-spawner.js");
        const tempCwd = mkdtempSync(join(tmpdir(), "session-spawner-refresh-test-"));
        try {
            const runningSessions = new Map();
            spawnSession(
                "sess-refresh",
                "api-key",
                "https://relay.example",
                tempCwd,
                runningSessions,
                new Set(),
                new Set(),
            );
            const child = runningSessions.get("sess-refresh")?.child as FakeChild;
            expect(child).toBeDefined();

            child.emit("message", { type: "refresh_usage_request", requestId: "req-1" });
            await Promise.resolve();
            await Promise.resolve();

            expect(refreshAndWriteRunnerUsageCache).toHaveBeenCalledTimes(1);
            expect(refreshCalls[0]).toEqual({ forceAnthropic: true });
            expect(child.send).toHaveBeenCalledWith({ type: "refresh_usage_complete", requestId: "req-1" });
        } finally {
            rmSync(tempCwd, { recursive: true, force: true });
        }
    });

    test("reports worker startup outcome only after the worker's startup IPC (review R13)", async () => {
        const isCwdAllowed = mock((_cwd: string | undefined) => true);
        class FakeChild extends EventEmitter {
            pid = 4322;
            killed = false;
            exitCode: number | null = null;
            send = mock((_msg: unknown) => {});
        }
        const children: FakeChild[] = [];
        const spawnMock = mock((_execPath: string, _args: string[], _options: any) => {
            const c = new FakeChild();
            children.push(c);
            return c;
        });
        mock.module("node:child_process", () => ({ ...realChildProcess, spawn: spawnMock, execFile: mock(() => {}) }));
        mock.module("../extensions/session-attachments.js", () => ({ cleanupSessionAttachments: mock(async () => {}) }));
        mock.module("./logger.js", () => ({ logInfo: mock(() => {}) }));
        mock.module("./runner-usage-cache.js", () => ({
            runnerUsageCacheFilePath: () => "/tmp/test-usage-cache.json",
            trackSessionCwd: mock(() => {}),
            untrackSessionCwd: mock(() => {}),
            refreshAndWriteRunnerUsageCache: mock(async () => {}),
        }));
        mock.module("./workspace.js", () => ({ isCwdAllowed }));
        mock.module("./session-procs.js", () => ({
            ensureSessionProcDir: () => {},
            sessionProcFilePath: (_sessionId: string) => "/tmp/test-session-startup.procs",
            readRecordedGroupPids: () => [],
            recordSessionGroupPid: () => {},
            removeSessionProcFile: () => {},
        }));

        const { spawnSession } = await import("./session-spawner.js");
        const tempCwd = mkdtempSync(join(tmpdir(), "session-spawner-startup-test-"));
        const killSpy = spyOn(process, "kill").mockImplementation((() => true) as any);
        try {
            // Fail-closed sandbox: the worker reports startup_error, then exits.
            const failed: unknown[] = [];
            spawnSession("sess-fail", "k", "https://relay.example", tempCwd, new Map(), new Set(), new Set(), undefined, {
                onStartup: (r) => failed.push(r),
                shutdownGraceMs: 1,
            });
            expect(failed).toEqual([]); // nothing reported at spawn time
            children[0]!.emit("message", { type: "startup_error", message: "Refusing to start: sandbox unavailable" });
            children[0]!.emit("exit", 1, null);
            expect(failed).toEqual([{ ok: false, message: "Refusing to start: sandbox unavailable" }]);

            // Healthy worker: ready only after startup_ready.
            const ready: unknown[] = [];
            spawnSession("sess-ok", "k", "https://relay.example", tempCwd, new Map(), new Set(), new Set(), undefined, {
                onStartup: (r) => ready.push(r),
            });
            expect(ready).toEqual([]);
            children[1]!.emit("message", { type: "startup_ready" });
            expect(ready).toEqual([{ ok: true }]);

            // Silent early exit is an error too.
            const silent: unknown[] = [];
            spawnSession("sess-silent", "k", "https://relay.example", tempCwd, new Map(), new Set(), new Set(), undefined, {
                onStartup: (r) => silent.push(r),
                shutdownGraceMs: 1,
            });
            children[2]!.emit("exit", 1, null);
            expect(silent).toHaveLength(1);
            expect(silent[0]).toMatchObject({ ok: false });
        } finally {
            killSpy.mockRestore();
            rmSync(tempCwd, { recursive: true, force: true });
        }
    });
});
