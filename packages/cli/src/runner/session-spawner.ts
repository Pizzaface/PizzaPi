import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanupSessionAttachments } from "../extensions/session-attachments.js";
import { logInfo } from "./logger.js";
import { forceKillTree } from "./process-kill.js";
import {
    sessionProcFilePath,
    ensureSessionProcDir,
    readRecordedGroupPids,
    recordSessionGroupPid,
    removeSessionProcFile,
} from "./session-procs.js";
import { runnerUsageCacheFilePath, trackSessionCwd, untrackSessionCwd, refreshAndWriteRunnerUsageCache } from "./runner-usage-cache.js";
import { recordTranscriptLink } from "./session-transcript-links.js";
import { isCwdAllowed } from "./workspace.js";
import { watchWorkerStartup, WORKER_STARTUP_TIMEOUT_MS, type WorkerStartupResult } from "./worker-startup.js";
import { loadConfig } from "../config.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isStrippedSubprocessEnvName } from "@pizzapi/tools";
import { hostPiNodePath } from "./host-pi-node-path.js";

export type SpawnFailureKind = "auth" | "crash" | "timeout" | "spawn_error";
export interface SpawnFailureDetails {
    kind: SpawnFailureKind;
    detail: string;
    exitCode?: number | null;
}

// Word-boundary anchored: an unanchored /auth|401|403/ matched "author",
// "OAuth" (the "auth" inside is not itself word-bounded, but "author"'s is,
// and so is the standalone "auth" below), and PIDs/ports like "14013"
// (contains "401" as a free substring). \b requires a non-word boundary on
// each side, so it only fires on "401"/"403" as their own token and on
// "auth" as its own word (not as a prefix/substring of a longer word).
const AUTH_FAILURE_PATTERN = /\b40[13]\b|\bunauthori[sz]ed\b|\bapi[-\s]?key\b|\bauth\b/;

export function classifySpawnFailure(detail: string, exitCode?: number | null): SpawnFailureDetails {
    const lower = detail.toLowerCase();
    const kind: SpawnFailureKind = AUTH_FAILURE_PATTERN.test(lower)
        ? "auth"
        : /timeout|timed out/.test(lower)
            ? "timeout"
            : /spawn|entrypoint|enoent|cwd does not exist|not a directory/.test(lower)
                ? "spawn_error"
                : "crash";
    return { kind, detail, ...(exitCode !== undefined ? { exitCode } : {}) };
}

export interface RunnerSession {
    sessionId: string;
    child: ChildProcess | null;
    startedAt: number;
    /**
     * True if this session was re-adopted after a daemon restart.
     * Adopted sessions have no child process handle — the worker is still
     * running independently with its own relay connection.
     */
    adopted?: boolean;
    /** ID of the parent session that spawned this one. */
    parentSessionId?: string;
    /** JSONL transcript file for this relay session, reported by the worker after startup. */
    sessionFile?: string;
}

/**
 * Kill an entire session process group (worker + everything it spawned:
 * bash children, MCP stdio servers, dev servers).  Workers are spawned with
 * `detached: true`, making the worker PID the process-group ID.
 * Returns false if the group signal could not be sent (already dead, or
 * platform without process groups).
 */
export function killSessionProcessGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (!Number.isFinite(pid) || pid! <= 0 || !Number.isInteger(pid)) return false;
    try {
        process.kill(-pid!, signal);
        return true;
    } catch {
        return false;
    }
}

/**
 * Grace window for a worker's process group and recorded command groups to
 * shut down cleanly before SIGKILL on the natural-exit cleanup path. Must stay
 * in sync with SESSION_SHUTDOWN_GRACE_MS in daemon.ts (currently 8_000ms).
 */
const SESSION_SHUTDOWN_GRACE_MS = 8_000;

/**
 * Returns true if the process group for pgid is still alive.
 * Uses signal 0 (no actual signal delivered) as the liveness probe.
 * ESRCH = no such process/group (dead); EPERM = exists but no permission (alive).
 */
function isProcessGroupAlive(pgid: number): boolean {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch (err: unknown) {
        return (err as NodeJS.ErrnoException)?.code === "EPERM";
    }
}

/**
 * Send SIGKILL to the worker's process group and any recorded command groups
 * after `timeoutMs`. Mirrors the escalation used by the explicit kill paths
 * in daemon.ts; reused here so SIGTERM-ignoring descendants cannot outlive a
 * natural worker exit.
 *
 * Cross-ref: daemon.ts:escalateToSigkill gates on !child.killed && exitCode===null
 * (child is still running). This path is for natural-exit cleanup (child already
 * exited), so we use a signal-0 probe instead. Residual race: a pgid could be
 * recycled in the ~microseconds between the probe and the kill — acceptable given
 * the probe eliminates the common multi-second stale-pgid window.
 */
function escalateCleanupToSigkill(
    child: ChildProcess,
    groupPids: number[],
    label: string,
    timeoutMs = SESSION_SHUTDOWN_GRACE_MS,
): void {
    const timer = setTimeout(() => {
        try {
            const childPid = child.pid;
            // Probe each process group with signal 0 before sending SIGKILL.
            // If the probe throws ESRCH the group is already gone — SIGTERM
            // worked, or the process exited naturally. Skip SIGKILL to avoid
            // hitting a recycled pgid that now belongs to a different process.
            if (childPid && isProcessGroupAlive(childPid)) {
                // Fall back to tree-kill (Windows) / plain kill if group signaling fails.
                if (!killSessionProcessGroup(childPid, "SIGKILL")) forceKillTree(child);
            }
            for (const groupPid of groupPids) {
                if (groupPid !== childPid && isProcessGroupAlive(groupPid)) {
                    killSessionProcessGroup(groupPid, "SIGKILL");
                }
            }
            logInfo(`session ${label} force-killed remaining groups after ${timeoutMs}ms`);
        } catch {
            // Process already exited; ignore.
        }
    }, timeoutMs);
    // Don't let the escalation timer keep the daemon alive if it's otherwise
    // exiting; the explicit kill paths in daemon.ts are active shutdowns and
    // don't unref, but this is a background cleanup timeout.
    timer.unref();
}

/**
 * Tell every live worker that the daemon is restarting on purpose, so they do
 * not exit when the IPC channel closes.  Waits for the sends to flush (bounded)
 * because the daemon exits right after this returns.
 */
export async function notifyWorkersOfRestart(
    runningSessions: Map<string, RunnerSession>,
    timeoutMs = 1_000,
): Promise<void> {
    const sends = Array.from(runningSessions.values())
        .map((s) => s.child)
        .filter((c): c is ChildProcess => !!c?.connected)
        .map((child) => new Promise<void>((resolve) => {
            try {
                child.send({ type: "detach" }, () => resolve());
            } catch {
                resolve();
            }
        }));
    if (sends.length === 0) return;
    await Promise.race([
        Promise.all(sends),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
}

/** Is this process running inside a compiled Bun single-file binary? */
// Detect compiled Bun single-file binary.
// - Unix: import.meta.url contains "$bunfs"
// - Windows: import.meta.url contains "~BUN" (drive letter/format varies)
export const isCompiledBinary = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

const WORKER_ENV_DENYLIST = new Set([
    "PIZZAPI_RUNNER_TOKEN",
    "PIZZAPI_RUNNER_API_KEY",
    // Per-session provider snapshot — each worker derives its own from
    // PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER; never inherit the daemon's.
    "PIZZAPI_SESSION_PROVIDER",
    "NODE_OPTIONS",
    "BUN_OPTIONS",           // Bun equivalent of NODE_OPTIONS — can inject code via --preload
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_FORCE_FLAT_NAMESPACE",
]);

// Docker/K8s `<NAME>_FILE` secret pointers (e.g. PIZZAPI_API_KEY_FILE,
// PIZZAPI_RUNNER_TOKEN_FILE) were already expanded by the CLI entrypoint
// that started this daemon. A worker never needs them — it gets its own
// PIZZAPI_API_KEY in spawnSession — and forwarding them would let the worker (whose
// compiled-binary entrypoint re-runs that expansion) or any process it
// starts re-read a daemon credential from disk.
function isWorkerEnvDenied(key: string): boolean {
    if (WORKER_ENV_DENYLIST.has(key)) return true;
    if (!key.toUpperCase().endsWith("_FILE")) return false;
    const base = key.slice(0, -"_FILE".length);
    return WORKER_ENV_DENYLIST.has(base.toUpperCase()) || isStrippedSubprocessEnvName(base);
}

/**
 * The `envOverrides` a worker for `cwd` receives: the merged global+project
 * config (project keys in GLOBAL_ONLY_ENV_OVERRIDES are already dropped by
 * loadConfig), restricted to non-denied `PIZZAPI_*` keys.
 */
export function workerEnvOverrides(cwd: string): Record<string, string> {
    const envOverrides: Record<string, string> = {};
    for (const [key, val] of Object.entries(loadConfig(cwd).envOverrides ?? {})) {
        if (key.startsWith("PIZZAPI_") && !isWorkerEnvDenied(key) && typeof val === "string") {
            envOverrides[key] = val;
        }
    }
    return envOverrides;
}

/**
 * Returns the spawn arguments for starting a worker subprocess.
 * - Compiled binary: `[process.execPath, ["_worker"]]`
 * - Source / built JS: `[process.execPath, [workerFilePath]]`
 */
export function resolveWorkerSpawnArgs(): string[] {
    if (isCompiledBinary) {
        // In a compiled binary, the worker code is embedded. We re-invoke
        // the same binary with the `_worker` subcommand.
        return ["_worker"];
    }

    const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const url = new URL(`./worker.${ext}`, import.meta.url);
    const path = fileURLToPath(url);
    if (!existsSync(path)) {
        const altExt = ext === "ts" ? "js" : "ts";
        const alt = fileURLToPath(new URL(`./worker.${altExt}`, import.meta.url));
        if (existsSync(alt)) return [alt];
        throw new Error(`Runner worker entrypoint not found: ${path}`);
    }
    return [path];
}

export function spawnSession(
    sessionId: string,
    apiKey: string,
    relayUrl: string,
    requestedCwd: string | undefined,
    runningSessions: Map<string, RunnerSession>,
    restartingSessions: Set<string>,
    killedSessions: Set<string>,
    onRestartRequested?: () => void,
    options?: {
        prompt?: string;
        imageUrls?: string[];
        model?: { provider: string; id: string };
        effort?: ThinkingLevel;
        hiddenModels?: string[];
        agent?: { name: string; systemPrompt?: string; tools?: string; disallowedTools?: string };
        parentSessionId?: string;
        resumePath?: string;
        autoClose?: boolean;
        /**
         * Override the SIGTERM→SIGKILL escalation delay for tests.
         * @internal
         */
        shutdownGraceMs?: number;
        /**
         * Daemon-owned cleanup hook invoked when the worker process truly exits
         * (not a restart-in-place). Lets the daemon run session-scoped service
         * cleanup (tunnels, git watchers, …) even when the relay is down and
         * its `session_ended` event never arrives. Must be idempotent — the
         * relay event may still fire later and re-run the same cleanup.
         */
        onSessionExit?: (sessionId: string) => void;
        /**
         * Called once with the worker's startup outcome (see worker-startup.ts):
         * ok after the worker reports its sandbox stage passed, or an error
         * when it reports a startup failure or exits first. Bounded by
         * `startupTimeoutMs`; a restart-in-place before readiness does not
         * call it (the replacement worker reports for itself).
         */
        onStartup?: (result: WorkerStartupResult) => void;
        /** Called when a linked child process exits abnormally after spawn. */
        onSessionFailure?: (sessionId: string, failure: SpawnFailureDetails) => void;
        /** @internal Override the startup report timeout for tests. */
        startupTimeoutMs?: number;
    },
): void {
    logInfo(`spawning headless worker for session ${sessionId}…`);

    if (runningSessions.has(sessionId)) {
        throw new Error(`Session already running: ${sessionId}`);
    }

    // Ensure the recorded-group pid file directory exists before the worker
    // starts appending to it.
    ensureSessionProcDir();

    // Resolve the effective cwd for this session now so we can register it for
    // usage auth lookups and clean it up on exit without re-deriving it.
    const effectiveCwd = requestedCwd ?? process.cwd();

    if (!isCwdAllowed(effectiveCwd)) {
        throw new Error(`Requested cwd is outside allowed workspace root(s): ${effectiveCwd}`);
    }

    if (!existsSync(effectiveCwd)) {
        throw new Error(`cwd does not exist: ${effectiveCwd}`);
    }
    const st = statSync(effectiveCwd);
    if (!st.isDirectory()) {
        throw new Error(`cwd is not a directory: ${effectiveCwd}`);
    }

    const workerArgs = resolveWorkerSpawnArgs();

    // Build the worker environment using a denylist approach: forward everything
    // from the daemon's environment EXCEPT a small set of daemon-internal
    // secrets and code-injection vectors that workers must never inherit.
    //
    // An allowlist was tried first but it proved too fragile — it silently
    // dropped ANTHROPIC_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN, MCP_TOKEN, and
    // every other provider/MCP auth var that workers legitimately need.
    //
    // Daemon-internal vars that workers must NOT receive:
    //   PIZZAPI_RUNNER_TOKEN     – relay auth token used only by the daemon
    //   PIZZAPI_RUNNER_API_KEY   – daemon-level API key; each worker gets its own
    //
    // Code/library injection vectors that should never be inherited:
    //   NODE_OPTIONS             – could inject arbitrary code via --require
    //   LD_PRELOAD               – shared-library injection (Linux)
    //   DYLD_INSERT_LIBRARIES    – shared-library injection (macOS)
    //   DYLD_FORCE_FLAT_NAMESPACE
    // (see WORKER_ENV_DENYLIST / isWorkerEnvDenied above)
    const baseEnv: Record<string, string> = {};
    for (const [key, val] of Object.entries(process.env)) {
        if (!isWorkerEnvDenied(key) && typeof val === "string") {
            baseEnv[key] = val;
        }
    }

    const envOverrides = workerEnvOverrides(effectiveCwd);

    const env: Record<string, string> = {
        ...baseEnv,
        ...envOverrides,
        // Use the daemon's resolved relay URL so workers always connect to the
        // same relay the daemon is using (not a potentially-changed config file).
        PIZZAPI_RELAY_URL: relayUrl,
        PIZZAPI_API_KEY: apiKey,
        PIZZAPI_SESSION_ID: sessionId,
        // Tell the worker where the runner-managed usage cache lives so it can
        // read quota data without making its own provider API calls.
        PIZZAPI_RUNNER_USAGE_CACHE_PATH: runnerUsageCacheFilePath(),
        // Per-session file where the worker's bash command prefix records each
        // command's detached group-leader PID, so the daemon can enumerate and
        // kill background processes that escaped the worker's own process group.
        PIZZAPI_SESSION_PROC_FILE: sessionProcFilePath(sessionId),
        ...(requestedCwd ? { PIZZAPI_WORKER_CWD: requestedCwd } : {}),
        // Initial prompt and model for the new session (set by spawn_session tool).
        ...(options?.prompt ? { PIZZAPI_WORKER_INITIAL_PROMPT: options.prompt } : {}),
        ...(options?.imageUrls && options.imageUrls.length > 0
            ? { PIZZAPI_WORKER_INITIAL_IMAGE_URLS: JSON.stringify(options.imageUrls) }
            : {}),
        ...(options?.model ? {
            PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER: options.model.provider,
            PIZZAPI_WORKER_INITIAL_MODEL_ID: options.model.id,
        } : {}),
        ...(options?.effort ? { PIZZAPI_WORKER_INITIAL_EFFORT: options.effort } : {}),
        // Hidden model keys (JSON array of "provider/modelId" strings).
        // The list_models tool filters these from its output.
        ...(options?.hiddenModels && options.hiddenModels.length > 0
            ? { PIZZAPI_HIDDEN_MODELS: JSON.stringify(options.hiddenModels) }
            : {}),
        // Agent session config — spawn the worker "as" this agent.
        // Parent session ID for trigger system (child→parent communication).
        ...(options?.parentSessionId ? { PIZZAPI_WORKER_PARENT_SESSION_ID: options.parentSessionId } : {}),
        ...(options?.agent?.name ? { PIZZAPI_WORKER_AGENT_NAME: options.agent.name } : {}),
        ...(options?.agent?.systemPrompt ? { PIZZAPI_WORKER_AGENT_SYSTEM_PROMPT: options.agent.systemPrompt } : {}),
        ...(options?.agent?.tools ? { PIZZAPI_WORKER_AGENT_TOOLS: options.agent.tools } : {}),
        ...(options?.agent?.disallowedTools ? { PIZZAPI_WORKER_AGENT_DISALLOWED_TOOLS: options.agent.disallowedTools } : {}),
        ...(options?.resumePath ? { PIZZAPI_WORKER_RESUME_PATH: options.resumePath } : {}),
        ...(options?.autoClose ? { PIZZAPI_WORKER_AUTO_CLOSE: "true" } : {}),
    };
    // Pin pi packages' runtime pi imports to the host copy (see host-pi-node-path.ts).
    const nodePath = hostPiNodePath(env.NODE_PATH);
    if (nodePath) env.NODE_PATH = nodePath;

    const child = spawn(process.execPath, workerArgs, {
        env,
        // New process group (PGID = worker PID).  Everything the session spawns
        // (bash commands, MCP stdio servers, dev servers) inherits the group, so
        // we can enumerate it (pgrep -g) and kill it wholesale on session end.
        detached: true,
        // Include an IPC channel (fd[3]) so the worker can send a "pre_restart"
        // message to the daemon before calling process.exit(43).  This lets us
        // add the sessionId to restartingSessions *before* the process exits and
        // before the relay's session_ended event (which travels over Socket.IO) can
        // arrive — closing the race where session_ended beats child.on("exit") and
        // incorrectly deletes attachments for a still-live restarting session.
        stdio: ["ignore", "inherit", "inherit", "ipc"],
    });

    if (options?.onStartup) {
        watchWorkerStartup(child, options.onStartup, {
            timeoutMs: options.startupTimeoutMs ?? WORKER_STARTUP_TIMEOUT_MS,
            onTimeout: () => logInfo(`session ${sessionId} worker has not reported startup yet; reporting it ready anyway`),
        });
    }

    // Pre-restart IPC signal: the worker sends this before calling process.exit(43).
    // Marking restartingSessions here (synchronously, while the worker is still
    // alive) guarantees the guard is set before any relay session_ended event arrives.
    // Set by the worker's "pre_suspend" IPC: it is exiting idle while the relay
    // keeps the session, and a wake respawns it under the same ID.
    let suspended = false;
    child.on("message", (msg: unknown) => {
        if (typeof msg !== "object" || msg === null) return;
        const message = msg as Record<string, unknown>;
        if (message.type === "pre_suspend") {
            suspended = true;
            logInfo(`session ${sessionId} suspending via IPC`);
            return;
        }
        if (message.type === "pre_restart") {
            restartingSessions.add(sessionId);
            logInfo(`session ${sessionId} signaled pre-restart via IPC`);
            return;
        }
        if (message.type === "refresh_usage_request" && typeof message.requestId === "string") {
            // Worker asked for an immediate usage refresh (e.g. user clicked
            // Refresh in the web UI). Force Anthropic so the UI sees current
            // quota, but still refresh Codex on the normal path.
            void refreshAndWriteRunnerUsageCache({ forceAnthropic: true }).finally(() => {
                child.send?.({ type: "refresh_usage_complete", requestId: message.requestId });
            });
            return;
        }
        if (message.type === "session_metadata" && typeof message.sessionFile === "string") {
            const running = runningSessions.get(sessionId);
            if (running) running.sessionFile = message.sessionFile;
            // Durable so a respawn after a daemon restart can still resume it.
            recordTranscriptLink(sessionId, message.sessionFile);
            logInfo(`session ${sessionId} reported transcript ${message.sessionFile}`);
        }
    });

    // Register this session's cwd so usage fetches can probe its project-local
    // agentDir override (if any).  Cleaned up on exit below.
    trackSessionCwd(sessionId, effectiveCwd);

    child.on("exit", (code, signal) => {
        // A wake may already have respawned this session — never drop its entry.
        const current = runningSessions.get(sessionId);
        if (!current || current.child === child) {
            runningSessions.delete(sessionId);
            untrackSessionCwd(sessionId, effectiveCwd);
        }
        logInfo(`session ${sessionId} exited (code=${code}, signal=${signal})`);
        if (suspended && !killedSessions.has(sessionId)) {
            // Suspended, not ended: keep attachments and session services for
            // the resumed worker. Only reap this worker's own process group.
            if (killSessionProcessGroup(child.pid)) {
                logInfo(`session ${sessionId} suspended worker group ${child.pid} signaled for cleanup`);
            }
            if (!runningSessions.has(sessionId)) removeSessionProcFile(sessionId);
            return;
        }
        if (code === 43 && onRestartRequested && !killedSessions.has(sessionId)) {
            // Restart-in-place: re-spawn immediately without touching attachments.
            // The session continues under the same ID — files saved to
            // ~/.pizzapi/session-attachments/{sessionId} must survive the restart.
            // restartingSessions was already populated via the IPC "pre_restart"
            // message above; this add is a belt-and-suspenders fallback for the
            // (unlikely) case where the IPC message was not sent or was lost.
            restartingSessions.add(sessionId);
            // Background processes from the old worker's group survive a
            // restart-in-place (intentional — session continues) but keep the
            // old worker's PGID, not the new worker's. Record that historical
            // group in the session pid file so the Processes panel keeps
            // listing it and the final session cleanup (SIGTERM → SIGKILL)
            // reaps it. Only record a group that still has live members so a
            // dead PGID is never kept around to be recycled.
            if (child.pid && isProcessGroupAlive(child.pid)) {
                recordSessionGroupPid(sessionProcFilePath(sessionId), child.pid);
                logInfo(`session ${sessionId} retained prior worker process group ${child.pid} for cleanup`);
            }
            logInfo(`re-spawning session ${sessionId} (worker restart requested)`);
            onRestartRequested();
        } else {
            // An intentional kill_session teardown (including one that
            // escalates SIGTERM to SIGKILL after the grace window, or one that
            // raced a restart-in-place exit code 43 into this branch above)
            // is not a crash — killedSessions is set BEFORE the signal is sent,
            // so it is still present here even though the worker already exited.
            // Reporting a failure for a deliberate teardown would falsely steer
            // the parent session after the user/tool asked for this session to end.
            if (options?.parentSessionId && (code !== 0 || signal) && !killedSessions.has(sessionId)) {
                options.onSessionFailure?.(
                    sessionId,
                    classifySpawnFailure(`Session worker exited (code=${code}, signal=${signal})`, code),
                );
            }
            // True termination — clean up persisted attachments now.
            // session_ended will also arrive later but runningSessions will be empty
            // by then, so this is the reliable cleanup point for spawned sessions.
            // Also remove from tracking sets if this was an explicit kill or a failed restart to prevent leaks.
            restartingSessions.delete(sessionId);
            killedSessions.delete(sessionId);
            // Reap any stragglers the session left behind (background dev
            // servers etc.) — the worker is gone, so signal its whole group
            // plus every recorded bash-command group (which is where detached
            // background processes actually live), then drop the pid file.
            const groupPids = readRecordedGroupPids(sessionProcFilePath(sessionId));
            if (killSessionProcessGroup(child.pid)) {
                logInfo(`session ${sessionId} process group ${child.pid} signaled for cleanup`);
            }
            for (const groupPid of groupPids) {
                if (groupPid !== child.pid) killSessionProcessGroup(groupPid);
            }
            // Escalate to SIGKILL after the grace window, matching the
            // explicit-kill paths in daemon.ts.
            escalateCleanupToSigkill(
                child,
                groupPids,
                sessionId,
                options?.shutdownGraceMs ?? SESSION_SHUTDOWN_GRACE_MS,
            );
            removeSessionProcFile(sessionId);
            void cleanupSessionAttachments(sessionId).catch(() => {});
            try {
                options?.onSessionExit?.(sessionId);
            } catch (err) {
                logInfo(`session ${sessionId} onSessionExit cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    });

    runningSessions.set(sessionId, { sessionId, child, startedAt: Date.now(), parentSessionId: options?.parentSessionId });
    logInfo(`session ${sessionId} worker spawned (pid=${child.pid})`);
}
