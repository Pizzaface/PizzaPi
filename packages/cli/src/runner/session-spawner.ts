import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanupSessionAttachments } from "../extensions/session-attachments.js";
import { logInfo } from "./logger.js";
import { runnerUsageCacheFilePath, trackSessionCwd, untrackSessionCwd } from "./runner-usage-cache.js";
import { isCwdAllowed } from "./workspace.js";

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
    /** True when this daemon owns the adopted Claude Code bridge process. */
    bridgeManaged?: boolean;
    /** Whether the adopted Claude Code bridge process is still believed alive. */
    bridgeAlive?: boolean;
    /** ID of the parent session that spawned this one. */
    parentSessionId?: string;
    /** Effective cwd for usage-auth tracking and cleanup. */
    cwd?: string;
}

/** Is this process running inside a compiled Bun single-file binary? */
// Detect compiled Bun single-file binary.
// - Unix: import.meta.url contains "$bunfs"
// - Windows: import.meta.url contains "~BUN" (drive letter/format varies)
export const isCompiledBinary = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

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
    onRestartRequested?: () => void,
    options?: {
        prompt?: string;
        model?: { provider: string; id: string };
        hiddenModels?: string[];
        agent?: { name: string; systemPrompt?: string; tools?: string; disallowedTools?: string };
        parentSessionId?: string;
    },
): void {
    logInfo(`spawning headless worker for session ${sessionId}…`);

    if (runningSessions.has(sessionId)) {
        throw new Error(`Session already running: ${sessionId}`);
    }

    // Resolve the effective cwd for this session now so we can register it for
    // usage auth lookups and clean it up on exit without re-deriving it.
    const effectiveCwd = requestedCwd ?? process.cwd();

    if (!isCwdAllowed(requestedCwd)) {
        throw new Error(`Requested cwd is outside allowed workspace root(s): ${requestedCwd}`);
    }

    if (requestedCwd) {
        if (!existsSync(requestedCwd)) {
            throw new Error(`cwd does not exist: ${requestedCwd}`);
        }
        const st = statSync(requestedCwd);
        if (!st.isDirectory()) {
            throw new Error(`cwd is not a directory: ${requestedCwd}`);
        }
    }

    const workerArgs = resolveWorkerSpawnArgs();

    const env: Record<string, string> = {
        ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string")) as any,
        // Use the daemon's resolved relay URL so workers always connect to the
        // same relay the daemon is using (not a potentially-changed config file).
        PIZZAPI_RELAY_URL: relayUrl,
        PIZZAPI_API_KEY: apiKey,
        PIZZAPI_SESSION_ID: sessionId,
        // Tell the worker where the runner-managed usage cache lives so it can
        // read quota data without making its own provider API calls.
        PIZZAPI_RUNNER_USAGE_CACHE_PATH: runnerUsageCacheFilePath(),
        ...(requestedCwd ? { PIZZAPI_WORKER_CWD: requestedCwd } : {}),
        // Initial prompt and model for the new session (set by spawn_session tool).
        ...(options?.prompt ? { PIZZAPI_WORKER_INITIAL_PROMPT: options.prompt } : {}),
        ...(options?.model ? {
            PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER: options.model.provider,
            PIZZAPI_WORKER_INITIAL_MODEL_ID: options.model.id,
        } : {}),
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
    };

    const child = spawn(process.execPath, workerArgs, {
        env,
        // Include an IPC channel (fd[3]) so the worker can send a "pre_restart"
        // message to the daemon before calling process.exit(43).  This lets us
        // add the sessionId to restartingSessions *before* the process exits and
        // before the relay's session_ended event (which travels over Socket.IO) can
        // arrive — closing the race where session_ended beats child.on("exit") and
        // incorrectly deletes attachments for a still-live restarting session.
        stdio: ["ignore", "inherit", "inherit", "ipc"],
    });

    // Pre-restart IPC signal: the worker sends this before calling process.exit(43).
    // Marking restartingSessions here (synchronously, while the worker is still
    // alive) guarantees the guard is set before any relay session_ended event arrives.
    child.on("message", (msg: unknown) => {
        if (typeof msg === "object" && msg !== null && (msg as Record<string, unknown>).type === "pre_restart") {
            restartingSessions.add(sessionId);
            logInfo(`session ${sessionId} signaled pre-restart via IPC`);
        }
    });

    // Register this session's cwd so usage fetches can probe its project-local
    // agentDir override (if any).  Cleaned up on exit below.
    trackSessionCwd(sessionId, effectiveCwd);

    child.on("exit", (code, signal) => {
        runningSessions.delete(sessionId);
        untrackSessionCwd(sessionId, effectiveCwd);
        logInfo(`session ${sessionId} exited (code=${code}, signal=${signal})`);
        if (code === 43 && onRestartRequested) {
            // Restart-in-place: re-spawn immediately without touching attachments.
            // The session continues under the same ID — files saved to
            // ~/.pizzapi/session-attachments/{sessionId} must survive the restart.
            // restartingSessions was already populated via the IPC "pre_restart"
            // message above; this add is a belt-and-suspenders fallback for the
            // (unlikely) case where the IPC message was not sent or was lost.
            restartingSessions.add(sessionId);
            logInfo(`re-spawning session ${sessionId} (worker restart requested)`);
            onRestartRequested();
        } else {
            // True termination — clean up persisted attachments now.
            // session_ended will also arrive later but runningSessions will be empty
            // by then, so this is the reliable cleanup point for spawned sessions.
            void cleanupSessionAttachments(sessionId).catch(() => {});
        }
    });

    runningSessions.set(sessionId, { sessionId, child, startedAt: Date.now(), parentSessionId: options?.parentSessionId });
    logInfo(`session ${sessionId} worker spawned (pid=${child.pid})`);
}
