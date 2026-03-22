import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
import { readdir, stat } from "node:fs/promises";
import { hostname } from "node:os";
import {
    spawnTerminal,
    writeTerminalInput,
    resizeTerminal,
    killTerminal,
    listTerminals,
    killAllTerminals,
} from "./terminal.js";
import { join, basename } from "node:path";
import { io, type Socket } from "socket.io-client";
import type { RunnerClientToServerEvents, RunnerServerToClientEvents } from "@pizzapi/protocol";
import { loadGlobalConfig } from "../config.js";
import { cleanupSessionAttachments, sweepOrphanedAttachments } from "../extensions/session-attachments.js";
import { setLogComponent, logInfo, logWarn, logError } from "./logger.js";
import { extractHookSummary } from "./hook-summary.js";
import { defaultStatePath, acquireStateAndIdentity, releaseStateLock } from "./runner-state.js";
import { startUsageRefreshLoop, stopUsageRefreshLoop } from "./runner-usage-cache.js";
import { getWorkspaceRoots, isCwdAllowed } from "./workspace.js";
import { type RunnerSession, spawnSession } from "./session-spawner.js";

import {
    type SkillMeta,
    scanGlobalSkills,
    readSkillContent,
    writeSkill,
    deleteSkill,
} from "../skills.js";

import {
    type AgentMeta,
    scanGlobalAgents,
    readAgentContent,
    writeAgent,
    deleteAgent,
} from "../agents.js";

import {
    scanAllPluginInfo,
} from "../plugins.js";

/**
 * Read the `relayUrl` from ~/.pizzapi/config.json, returning undefined
 * if not set or set to "off".  Used as a fallback when PIZZAPI_RELAY_URL
 * env var is not present (e.g. LaunchAgent contexts).
 */
function resolveConfigRelayUrl(): string | undefined {
    const cfg = loadGlobalConfig();
    const url = cfg.relayUrl;
    return url && url !== "off" ? url : undefined;
}

/**
 * Remote Runner daemon.
 *
 * Connects to the PizzaPi relay server over WebSocket and registers itself as
 * an available runner. The relay server (and through it the web UI) can then:
 *
 *   - Request a new agent session be spawned  (new_session)
 *   - List active sessions                    (list_sessions)
 *   - Kill a session                          (kill_session)
 *
 * Authentication: API key via PIZZAPI_API_KEY env var (required).
 *                (Back-compat: PIZZAPI_RUNNER_TOKEN server token)
 * Relay URL:      PIZZAPI_RELAY_URL env var, or `relayUrl` in ~/.pizzapi/config.json (default: ws://localhost:7492).
 * State file:     PIZZAPI_RUNNER_STATE_PATH env var (default: ~/.pizzapi/runner.json).
 */
export async function runDaemon(_args: string[] = []): Promise<number> {
    setLogComponent("daemon");
    const statePath = defaultStatePath();
    const identity = acquireStateAndIdentity(statePath);

    // Read CLI version for reporting to the server.
    // Use module import instead of filesystem path math so this works in:
    //   - source/dev runs (bun src/index.ts runner)
    //   - dist JS runs     (bun dist/index.js runner)
    //   - compiled binaries (where import.meta.url points into Bun's virtual FS)
    let cliVersion: string | undefined;
    try {
        const { default: pkg } = await import("../../package.json");
        cliVersion = typeof pkg?.version === "string" ? pkg.version : undefined;
    } catch {
        // Best-effort — version will be omitted if unreadable.
    }

    // Start fetching provider usage immediately so workers have cached data from
    // the moment they are spawned.  One daemon refresh covers all sessions on this node.
    startUsageRefreshLoop();

    // Load global config so relayUrl and apiKey can be read from
    // ~/.pizzapi/config.json (important for LaunchAgent contexts where
    // env vars aren't available).
    const daemonConfig = loadGlobalConfig();

    // Priority: env var > config.json > default
    const apiKey =
        process.env.PIZZAPI_RUNNER_API_KEY ??
        process.env.PIZZAPI_API_KEY ??
        process.env.PIZZAPI_API_TOKEN ??
        daemonConfig.apiKey;
    const token = process.env.PIZZAPI_RUNNER_TOKEN;

    if (!apiKey && !token) {
        logError("Set PIZZAPI_API_KEY (or PIZZAPI_API_TOKEN), or set apiKey in ~/.pizzapi/config.json.");
        releaseStateLock(statePath);
        process.exit(1);
    }

    return new Promise((resolve) => {
        let isShuttingDown = false;

        // ── Socket.IO connection setup ────────────────────────────────────
        // Priority: env var > config.json > default
        const relayRaw = (process.env.PIZZAPI_RELAY_URL ?? resolveConfigRelayUrl() ?? "ws://localhost:7492")
            .trim()
            .replace(/\/$/, "");

        // Normalise the relay URL for socket.io-client (needs http(s)://).
        // If the user supplies a bare hostname (no scheme), default to https://.
        function normaliseRelayUrl(raw: string): string {
            if (raw.startsWith("ws://"))      return raw.replace(/^ws:\/\//, "http://");
            if (raw.startsWith("wss://"))     return raw.replace(/^wss:\/\//, "https://");
            if (raw.startsWith("http://"))    return raw;
            if (raw.startsWith("https://"))   return raw;
            // No scheme — treat as an https host (e.g. "example.com" or "example.com:5173")
            return `https://${raw}`;
        }
        const sioUrl = normaliseRelayUrl(relayRaw);

        const runningSessions = new Map<string, RunnerSession>();
        // Sessions currently in the middle of a restart-in-place (exit code 43).
        // While a sessionId is in this set, the session_ended event arriving from the
        // relay (triggered when the new worker's registerTuiSession tears down the old
        // connection) must be ignored — the new worker is already live.
        const restartingSessions = new Set<string>();
        // Sessions we've already handled session_ended for.  Prevents log
        // spam when the relay fires duplicate session_ended events (e.g. the
        // orphan sweeper runs after the relay already sent session_ended on
        // disconnect).  Entries auto-expire after 5 min — must be comfortably
        // longer than the relay's sweep interval (default 60 s) to avoid
        // re-logging on the next sweep cycle.
        // Map of sessionId → timestamp (ms) when the entry was recorded.
        // A single shared sweep interval purges stale entries rather than
        // scheduling one setTimeout per session (which scales linearly with
        // session churn under high load).
        const endedSessionIds = new Map<string, number>();
        const ENDED_SESSION_TTL_MS = 5 * 60_000;
        const ENDED_SESSION_SWEEP_MS = 60_000; // sweep every 60 s
        const endedSessionSweep = setInterval(() => {
            const now = Date.now();
            for (const [id, ts] of endedSessionIds) {
                if (now - ts >= ENDED_SESSION_TTL_MS) endedSessionIds.delete(id);
            }
        }, ENDED_SESSION_SWEEP_MS);
        const runnerName = process.env.PIZZAPI_RUNNER_NAME?.trim() || hostname();
        let runnerId: string | null = null;
        let isFirstConnect = true;

        const socket: Socket<RunnerServerToClientEvents, RunnerClientToServerEvents> = io(
            sioUrl + "/runner",
            {
                auth: {
                    apiKey,
                    runnerId: identity.runnerId,
                    runnerSecret: identity.runnerSecret,
                },
                transports: ["websocket"],
                reconnection: true,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 30000,
            },
        );

        logInfo(`connecting to relay at ${sioUrl}/runner…`);

        const shutdown = (code: number) => {
            if (isShuttingDown) return;
            isShuttingDown = true;
            clearInterval(endedSessionSweep);
            killAllTerminals();
            stopUsageRefreshLoop();
            releaseStateLock(statePath);
            socket.disconnect();
            resolve(code);
        };

        process.on("SIGINT", () => shutdown(0));
        process.on("SIGTERM", () => shutdown(0));

        // ── Helper: emit registration ─────────────────────────────────────
        const emitRegister = () => {
            const skills = scanGlobalSkills();
            const agents = scanGlobalAgents();
            // Runner registration only advertises global plugins.
            // Project-local plugins are session-scoped — they're discovered
            // per-session via list_plugins with an explicit cwd.
            // Pass undefined as cwd so that discoverClaudeInstalledPlugins
            // skips project-scoped marketplace plugins and readEnabledPlugins
            // only reads user-level settings (not project-local overrides).
            const plugins = scanAllPluginInfo(undefined, { includeProjectLocal: false });
            const globalConfig = loadGlobalConfig();
            const hooks = extractHookSummary(globalConfig.hooks);
            socket.emit("register_runner", {
                runnerId: identity.runnerId,
                runnerSecret: identity.runnerSecret,
                name: runnerName,
                roots: getWorkspaceRoots(),
                skills,
                agents,
                plugins,
                hooks,
                version: cliVersion,
                platform: process.platform,
            });
        };

        // ── Connection lifecycle ──────────────────────────────────────────

        socket.on("connect", () => {
            if (isShuttingDown) {
                socket.disconnect();
                return;
            }
            const verb = isFirstConnect ? "connected" : "reconnected";
            isFirstConnect = false;
            logInfo(`${verb}. Registering as ${identity.runnerId}…`);
            emitRegister();
        });

        socket.on("disconnect", (reason) => {
            if (isShuttingDown) return;
            logInfo(`disconnected (${reason}). Socket.IO will reconnect automatically.`);
        });

        // ── Registration confirmation ─────────────────────────────────────

        socket.on("runner_registered", (data: any) => {
            runnerId = data.runnerId;
            if (runnerId !== identity.runnerId) {
                logWarn(`server assigned unexpected ID ${runnerId} (expected ${identity.runnerId})`);
            }
            logInfo(`registered as ${runnerId}`);

            // Re-adopt orphaned sessions that survived a daemon restart.
            // Their worker processes are still running and connected to the relay.
            const existingSessions = data.existingSessions ?? [];
            if (existingSessions.length > 0) {
                let adopted = 0;
                for (const { sessionId, cwd } of existingSessions) {
                    if (runningSessions.has(sessionId)) continue; // already tracked
                    runningSessions.set(sessionId, {
                        sessionId,
                        child: null,
                        startedAt: Date.now(),
                        adopted: true,
                    });
                    adopted++;
                }
                if (adopted > 0) {
                    logInfo(`re-adopted ${adopted} orphaned session(s): ${existingSessions.map((s: any) => s.sessionId.slice(0, 8)).join(", ")}`);
                }
            }

            // Sweep orphaned session attachment directories — removes dirs for
            // sessions that ended while the daemon was down or crashed.
            void sweepOrphanedAttachments(new Set(runningSessions.keys())).catch(() => {});
        });

        // ── Session management ────────────────────────────────────────────

        socket.on("new_session", (data: any) => {
            if (isShuttingDown) return;
            const { sessionId, cwd: requestedCwd, prompt: requestedPrompt, model: requestedModel, hiddenModels: requestedHiddenModels, agent: requestedAgent, parentSessionId: requestedParentSessionId } = data;

            if (!sessionId) {
                socket.emit("session_error", { sessionId: sessionId ?? "", message: "Missing sessionId" });
                return;
            }

            // The worker uses the runner's API key to register with the /relay namespace.
            if (!apiKey) {
                socket.emit("session_error", { sessionId, message: "Runner is missing PIZZAPI_API_KEY" });
                return;
            }

            // Resolve agent definition from disk when only a name is provided.
            // The UI sends { name: "researcher" } and the daemon resolves the
            // full agent file content so the worker can apply it.
            let resolvedAgent = requestedAgent;
            if (resolvedAgent?.name && !resolvedAgent.systemPrompt) {
                const content = readAgentContent(resolvedAgent.name);
                if (content) {
                    // Parse frontmatter to extract tools/disallowedTools, then use body as systemPrompt
                    const fmEnd = content.startsWith("---") ? content.indexOf("\n---", 3) : -1;
                    let body = content;
                    let tools = resolvedAgent.tools;
                    let disallowedTools = resolvedAgent.disallowedTools;
                    if (fmEnd !== -1) {
                        const fmBlock = content.slice(3, fmEnd);
                        body = content.slice(fmEnd + 4).trim();
                        // Extract tools from frontmatter if not explicitly provided
                        if (!tools) {
                            const toolsMatch = fmBlock.match(/^tools:\s*(.+)$/m);
                            if (toolsMatch) tools = toolsMatch[1].trim().replace(/^["']|["']$/g, "");
                        }
                        if (!disallowedTools) {
                            const dtMatch = fmBlock.match(/^disallowedTools:\s*(.+)$/m);
                            if (dtMatch) disallowedTools = dtMatch[1].trim().replace(/^["']|["']$/g, "");
                        }
                    }
                    resolvedAgent = { ...resolvedAgent, systemPrompt: body, tools, disallowedTools };
                } else {
                    logWarn(`agent "${resolvedAgent.name}" not found on disk`);
                    socket.emit("session_error", { sessionId, message: `Agent "${resolvedAgent.name}" not found on this runner` });
                    return;
                }
            }

            let isFirstSpawn = true;
            const doSpawn = () => {
                try {
                    // Only pass initial prompt/model on the first spawn.
                    // On restart (exit code 43), the session already has
                    // the prompt in its history — re-sending would duplicate it.
                    const spawnOpts = isFirstSpawn
                        ? { prompt: requestedPrompt, model: requestedModel, hiddenModels: requestedHiddenModels, agent: resolvedAgent, parentSessionId: requestedParentSessionId }
                        : { hiddenModels: requestedHiddenModels, agent: resolvedAgent, parentSessionId: requestedParentSessionId }; // Always pass agent + hidden models + parent on restart
                    isFirstSpawn = false;
                    spawnSession(sessionId, apiKey!, relayRaw, requestedCwd, runningSessions, restartingSessions, doSpawn, spawnOpts);
                    socket.emit("session_ready", { sessionId });
                } catch (err) {
                    socket.emit("session_error", {
                        sessionId,
                        message: err instanceof Error ? err.message : String(err),
                    });
                }
            };
            doSpawn();
        });

        socket.on("kill_session", (data: any) => {
            if (isShuttingDown) return;
            const { sessionId } = data;
            const entry = runningSessions.get(sessionId);
            if (entry) {
                if (entry.child) {
                    try {
                        entry.child.kill("SIGTERM");
                    } catch {}
                } else if (entry.adopted) {
                    // No child handle — ask the relay to disconnect the worker's
                    // socket, which sends end_session then force-disconnects.
                    socket.emit("disconnect_session", { sessionId });
                }
                runningSessions.delete(sessionId);
                logInfo(`killed session ${sessionId}${entry.adopted ? " (adopted)" : ""}`);
                socket.emit("session_killed", { sessionId });
                // Clean up persisted attachments for this session
                void cleanupSessionAttachments(sessionId).catch(() => {});
            }
        });

        // ── session_ended — relay notifies us a worker disconnected ───────
        socket.on("session_ended", (data: any) => {
            if (isShuttingDown) return;
            const { sessionId, reason } = data;

            // If this session just did a restart-in-place (exit code 43), the relay fires
            // session_ended when the new worker's registerTuiSession tears down the OLD
            // connection.  The new worker is already live in runningSessions — don't
            // delete its entry and don't touch its attachments.
            if (restartingSessions.has(sessionId)) {
                restartingSessions.delete(sessionId);
                logInfo(`session_ended for ${sessionId} — restarting in place, skipping teardown`);
                return;
            }

            // On relay reconnections the server tears down the old session record
            // before re-registering the same worker.  The worker is still alive —
            // don't delete its runningSessions entry or its attachments.
            if (reason === "Session reconnected") {
                logInfo(`session_ended for ${sessionId} — relay reconnect, skipping teardown`);
                return;
            }

            const entry = runningSessions.get(sessionId);
            if (entry) {
                // If the child process is still alive AND this is a transient
                // relay disconnect (not an expiry/orphan sweep), keep the entry
                // so the worker can reconnect.  For server-initiated cleanup
                // (expired/orphaned), always honor the removal — the session
                // is legitimately dead and the worker should exit on its own.
                const childAlive = entry.child && !entry.child.killed && entry.child.exitCode === null;
                const isTransientDisconnect = !reason || reason === "Session ended";
                if (childAlive && isTransientDisconnect) {
                    logInfo(`session_ended for ${sessionId} but worker still alive — keeping entry for reconnect`);
                    return;
                }
                runningSessions.delete(sessionId);
                endedSessionIds.set(sessionId, Date.now());
                logInfo(`session ${sessionId} ended on relay${entry.adopted ? " (adopted)" : ""}${reason ? ` (${reason})` : ""}`);
            } else if (!endedSessionIds.has(sessionId)) {
                // First duplicate — log once then suppress subsequent copies
                endedSessionIds.set(sessionId, Date.now());
                logInfo(`session_ended for unknown/already-removed session ${sessionId}`);
            }
            // else: duplicate session_ended for a session we already handled — silently ignore

            // Clean up persisted attachments.  For spawned sessions child.on("exit")
            // already ran cleanup, so this is a no-op (idempotent).  For adopted sessions
            // (child: null) this is the only cleanup path.
            void cleanupSessionAttachments(sessionId).catch(() => {});
        });

        socket.on("list_sessions", () => {
            if (isShuttingDown) return;
            // sessions_list is not in the typed protocol yet — emit untyped
            (socket as any).emit("sessions_list", {
                sessions: Array.from(runningSessions.keys()),
            });
        });


        // ── Daemon control ────────────────────────────────────────────────

        socket.on("restart", () => {
            logInfo("restart request received. Exiting with code 42...");
            setTimeout(() => {
                shutdown(42);
            }, 500);
        });

        socket.on("shutdown", () => {
            logInfo("shutdown request received. Exiting cleanly...");
            setTimeout(() => {
                shutdown(0);
            }, 500);
        });

        socket.on("ping", () => {
            if (isShuttingDown) return;
            // pong is not in the typed protocol yet — emit untyped
            (socket as any).emit("pong", { now: Date.now() });
        });

        // ── Terminal PTY management ───────────────────────────────────────

        socket.on("new_terminal", (data: any) => {
            if (isShuttingDown) return;
            const { terminalId, cwd: requestedCwd, cols, rows, shell } = data;
            logInfo(
                `[terminal] new_terminal received: terminalId=${terminalId} cwd=${requestedCwd ?? "(default)"} cols=${cols ?? 80} rows=${rows ?? 24} shell=${shell ?? "(default)"}`,
            );
            if (!terminalId) {
                logWarn("[terminal] new_terminal: missing terminalId — rejecting");
                socket.emit("terminal_error", { terminalId: "", message: "Missing terminalId" });
                return;
            }
            if (requestedCwd && !isCwdAllowed(requestedCwd)) {
                logWarn(
                    `[terminal] new_terminal: cwd="${requestedCwd}" outside allowed roots — rejecting terminalId=${terminalId}`,
                );
                socket.emit("terminal_error", {
                    terminalId,
                    message: `cwd outside allowed roots: ${requestedCwd}`,
                });
                return;
            }
            // The terminal module calls termSend with { type: "terminal_*", ... } payloads.
            // Extract the type field and emit it as a socket.io event.
            const termSend = (payload: Record<string, unknown>) => {
                try {
                    const { type, runnerId: _drop, ...rest } = payload;
                    if (typeof type === "string") {
                        (socket as any).emit(type, rest);
                    }
                } catch (err) {
                    logError(
                        `[terminal] termSend: failed to send ${payload.type} for terminalId=${terminalId}: ${err}`,
                    );
                }
            };
            spawnTerminal(terminalId, termSend, {
                cwd: requestedCwd,
                cols,
                rows,
                shell,
            });
        });

        socket.on("terminal_input", (data: any) => {
            if (isShuttingDown) return;
            const { terminalId, data: inputData } = data;
            if (!terminalId || !inputData) {
                logWarn(
                    `[terminal] terminal_input: missing terminalId or data (terminalId=${terminalId} dataLen=${inputData?.length ?? 0})`,
                );
                return;
            }
            writeTerminalInput(terminalId, inputData);
        });

        socket.on("terminal_resize", (data: any) => {
            if (isShuttingDown) return;
            const { terminalId, cols, rows } = data;
            if (!terminalId) {
                logWarn("[terminal] terminal_resize: missing terminalId");
                return;
            }
            logInfo(`[terminal] terminal_resize: terminalId=${terminalId} ${cols}x${rows}`);
            resizeTerminal(terminalId, cols, rows);
        });

        socket.on("kill_terminal", (data: any) => {
            if (isShuttingDown) return;
            const { terminalId } = data;
            if (!terminalId) {
                logWarn("[terminal] kill_terminal: missing terminalId");
                return;
            }
            logInfo(`[terminal] kill_terminal: terminalId=${terminalId}`);
            const killed = killTerminal(terminalId);
            logInfo(`[terminal] kill_terminal: result=${killed} terminalId=${terminalId}`);
            if (killed) {
                socket.emit("terminal_exit", { terminalId, exitCode: -1 });
            } else {
                socket.emit("terminal_error", { terminalId, message: "Terminal not found" });
            }
        });

        socket.on("list_terminals", () => {
            if (isShuttingDown) return;
            const list = listTerminals();
            logInfo(`[terminal] list_terminals: ${list.length} active (${list.join(", ") || "none"})`);
            // terminals_list is not in the typed protocol yet — emit untyped
            (socket as any).emit("terminals_list", { terminals: list });
        });

        // ── Skills management ─────────────────────────────────────────────

        socket.on("list_skills", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const skills = scanGlobalSkills();
            socket.emit("skills_list", { skills, requestId });
        });

        socket.on("create_skill", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const skillName = (data.name ?? "").trim();
            const skillContent = data.content ?? "";

            if (!skillName) {
                socket.emit("skill_result", { requestId, ok: false, message: "Missing skill name" });
                return;
            }

            if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(skillName) && !/^[a-z0-9]$/.test(skillName)) {
                socket.emit("skill_result", {
                    requestId,
                    ok: false,
                    message: "Invalid skill name: must be lowercase letters, numbers, and hyphens only",
                });
                return;
            }

            try {
                await writeSkill(skillName, skillContent);
                const skills = scanGlobalSkills();
                socket.emit("skill_result", { requestId, ok: true, skills });
            } catch (err) {
                socket.emit("skill_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("update_skill", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const skillName = (data.name ?? "").trim();
            const skillContent = data.content ?? "";

            if (!skillName) {
                socket.emit("skill_result", { requestId, ok: false, message: "Missing skill name" });
                return;
            }

            if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(skillName) && !/^[a-z0-9]$/.test(skillName)) {
                socket.emit("skill_result", {
                    requestId,
                    ok: false,
                    message: "Invalid skill name: must be lowercase letters, numbers, and hyphens only",
                });
                return;
            }

            try {
                await writeSkill(skillName, skillContent);
                const skills = scanGlobalSkills();
                socket.emit("skill_result", { requestId, ok: true, skills });
            } catch (err) {
                socket.emit("skill_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("delete_skill", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const skillName = (data.name ?? "").trim();

            if (!skillName) {
                socket.emit("skill_result", { requestId, ok: false, message: "Missing skill name" });
                return;
            }

            const deleted = deleteSkill(skillName);
            const skills = scanGlobalSkills();
            socket.emit("skill_result", {
                requestId,
                ok: deleted,
                message: deleted ? undefined : "Skill not found",
                skills,
            });
        });

        socket.on("get_skill", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const skillName = (data.name ?? "").trim();
            const content = skillName ? readSkillContent(skillName) : null;
            if (content === null) {
                socket.emit("skill_result", { requestId, ok: false, message: "Skill not found" });
            } else {
                socket.emit("skill_result", { requestId, ok: true, name: skillName, content });
            }
        });

        // ── Agents management ──────────────────────────────────────────────

        socket.on("list_agents", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const agents = scanGlobalAgents();
            socket.emit("agents_list", { agents, requestId });
        });

        socket.on("create_agent", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const agentName = (data.name ?? "").trim();
            const agentContent = data.content ?? "";

            if (!agentName) {
                socket.emit("agent_result", { requestId, ok: false, message: "Missing agent name" });
                return;
            }

            if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(agentName) && !/^[a-z0-9]$/.test(agentName)) {
                socket.emit("agent_result", {
                    requestId,
                    ok: false,
                    message: "Invalid agent name: must be lowercase letters, numbers, and hyphens only",
                });
                return;
            }

            try {
                await writeAgent(agentName, agentContent);
                const agents = scanGlobalAgents();
                socket.emit("agent_result", { requestId, ok: true, agents });
            } catch (err) {
                socket.emit("agent_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("update_agent", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const agentName = (data.name ?? "").trim();
            const agentContent = data.content ?? "";

            if (!agentName) {
                socket.emit("agent_result", { requestId, ok: false, message: "Missing agent name" });
                return;
            }

            // Relaxed validation for updates: accept any name the scanner
            // can discover (letters, digits, hyphens, underscores, dots)
            // but reject path separators to prevent directory traversal.
            if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(agentName)) {
                socket.emit("agent_result", {
                    requestId,
                    ok: false,
                    message: "Invalid agent name: must start with a letter or digit and contain only letters, digits, hyphens, underscores, or dots",
                });
                return;
            }

            try {
                await writeAgent(agentName, agentContent);
                const agents = scanGlobalAgents();
                socket.emit("agent_result", { requestId, ok: true, agents });
            } catch (err) {
                socket.emit("agent_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("delete_agent", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const agentName = (data.name ?? "").trim();

            if (!agentName) {
                socket.emit("agent_result", { requestId, ok: false, message: "Missing agent name" });
                return;
            }

            const deleted = deleteAgent(agentName);
            const agents = scanGlobalAgents();
            socket.emit("agent_result", {
                requestId,
                ok: deleted,
                message: deleted ? undefined : "Agent not found",
                agents,
            });
        });

        socket.on("get_agent", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const agentName = (data.name ?? "").trim();
            const content = agentName ? readAgentContent(agentName) : null;
            if (content === null) {
                socket.emit("agent_result", { requestId, ok: false, message: "Agent not found" });
            } else {
                socket.emit("agent_result", { requestId, ok: true, name: agentName, content });
            }
        });

        // ── Plugins management ─────────────────────────────────────────────

        socket.on("list_plugins", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data?.requestId;
            // Use the provided cwd (e.g. session's working directory) if
            // available, otherwise fall back to the daemon's own cwd.
            // Validate against workspace roots to prevent arbitrary path scanning.
            const rawCwd = (typeof data?.cwd === "string" && data.cwd) ? data.cwd : undefined;
            if (rawCwd && !isCwdAllowed(rawCwd)) {
                socket.emit("plugins_list", { plugins: [], requestId, ok: false, message: "cwd outside allowed workspace roots" });
                return;
            }
            // Only include project-local plugins when an explicit session cwd
            // was provided AND it's within allowed workspace roots. Without an
            // explicit cwd this is a runner-level query — only global plugins.
            // When rawCwd is absent, pass undefined so marketplace discovery
            // skips project-scoped plugins and respects only user-level settings.
            const scanCwd = rawCwd ?? undefined;
            const includeLocal = !!rawCwd && isCwdAllowed(rawCwd);
            const plugins = scanAllPluginInfo(scanCwd, { includeProjectLocal: includeLocal });
            // Echo scoped flag so the server can skip cache updates for per-session scans
            socket.emit("plugins_list", { plugins, requestId, ...(rawCwd ? { scoped: true } : {}) });
        });

        // ── File Explorer ─────────────────────────────────────────────────

        socket.on("list_files", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const dirPath = data.path ?? "";
            if (!dirPath) {
                socket.emit("file_result", { requestId, ok: false, message: "Missing path" });
                return;
            }
            if (!isCwdAllowed(dirPath)) {
                socket.emit("file_result", { requestId, ok: false, message: "Path outside allowed roots" });
                return;
            }
            try {
                const entries = await readdir(dirPath, { withFileTypes: true });
                const items = await Promise.all(
                    entries
                        .filter((e) => {
                            // Show all dotfiles/dotfolders except .git (too noisy)
                            if (e.name === ".git") return false;
                            return true;
                        })
                        .map(async (e) => {
                            const fullPath = join(dirPath, e.name);
                            let size: number | undefined;
                            try {
                                const s = await stat(fullPath);
                                size = s.size;
                            } catch {}
                            return {
                                name: e.name,
                                path: fullPath,
                                isDirectory: e.isDirectory(),
                                isSymlink: e.isSymbolicLink(),
                                size,
                            };
                        }),
                );
                // Directories first, then files, alphabetically
                items.sort((a, b) => {
                    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
                });
                socket.emit("file_result", { requestId, ok: true, files: items });
            } catch (err) {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("search_files", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const cwd = (data as any).cwd ?? "";
            const query = (data as any).query ?? "";
            const limit = typeof (data as any).limit === "number" ? (data as any).limit : 100;

            if (!cwd) {
                socket.emit("file_result", { requestId, ok: false, message: "Missing cwd" });
                return;
            }
            if (!isCwdAllowed(cwd)) {
                socket.emit("file_result", { requestId, ok: false, message: "Path outside allowed roots" });
                return;
            }
            if (!query) {
                socket.emit("file_result", { requestId, ok: true, files: [] });
                return;
            }
            try {
                // Use git ls-files to get tracked + untracked-not-ignored files.
                // Use async exec to avoid blocking the event loop (which would
                // prevent Socket.IO pings from being answered).
                const { stdout } = await execFileAsync(
                    "git",
                    ["ls-files", "--cached", "--others", "--exclude-standard"],
                    { cwd, timeout: 10000, maxBuffer: 10 * 1024 * 1024 },
                );
                const lowerQuery = query.toLowerCase();
                const files = stdout
                    .split("\n")
                    .filter((line) => {
                        if (!line) return false;
                        return line.toLowerCase().includes(lowerQuery);
                    })
                    .slice(0, limit)
                    .map((relativePath) => ({
                        name: relativePath.split("/").pop() ?? relativePath,
                        path: join(cwd, relativePath),
                        relativePath,
                        isDirectory: false,
                        isSymlink: false,
                    }));
                socket.emit("file_result", { requestId, ok: true, files });
            } catch (err) {
                // If git fails (not a git repo, etc.), return empty list
                const isGitError = err instanceof Error && (err as any).code !== undefined;
                if (isGitError) {
                    socket.emit("file_result", { requestId, ok: true, files: [] });
                    return;
                }
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("read_file", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const filePath = data.path ?? "";
            const encoding = (data as any).encoding ?? "utf8";
            const maxBytes = typeof (data as any).maxBytes === "number"
                ? (data as any).maxBytes
                : encoding === "base64"
                    ? 10 * 1024 * 1024
                    : 256 * 1024; // 10MB for base64, 256KB for text

            if (!filePath) {
                socket.emit("file_result", { requestId, ok: false, message: "Missing path" });
                return;
            }
            if (!isCwdAllowed(filePath)) {
                socket.emit("file_result", { requestId, ok: false, message: "Path outside allowed roots" });
                return;
            }
            try {
                const s = await stat(filePath);
                const truncated = s.size > maxBytes;
                if (encoding === "base64") {
                    const buf = await Bun.file(filePath).slice(0, maxBytes).arrayBuffer();
                    const b64 = Buffer.from(buf).toString("base64");
                    socket.emit("file_result", {
                        requestId,
                        ok: true,
                        content: b64,
                        encoding: "base64",
                        size: s.size,
                        truncated,
                    });
                } else {
                    const fd = await Bun.file(filePath).slice(0, maxBytes).text();
                    socket.emit("file_result", {
                        requestId,
                        ok: true,
                        content: fd,
                        size: s.size,
                        truncated,
                    });
                }
            } catch (err) {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        // ── Git operations ────────────────────────────────────────────────

        socket.on("git_status", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const cwd = data.cwd ?? "";
            if (!cwd) {
                socket.emit("file_result", { requestId, ok: false, message: "Missing cwd" });
                return;
            }
            if (!isCwdAllowed(cwd)) {
                socket.emit("file_result", { requestId, ok: false, message: "Path outside allowed roots" });
                return;
            }
            try {
                // Run all git commands asynchronously to avoid blocking the
                // event loop (which would prevent Socket.IO pings from being
                // answered, causing spurious disconnects).
                const [branchResult, statusResult, diffStagedResult, abResult] = await Promise.allSettled([
                    execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 5000 }),
                    execFileAsync("git", ["status", "--porcelain=v1", "-uall"], { cwd, timeout: 10000 }),
                    execFileAsync("git", ["diff", "--cached", "--stat"], { cwd, timeout: 10000 }),
                    execFileAsync("git", ["rev-list", "--left-right", "--count", "HEAD...@{u}"], { cwd, timeout: 5000 }),
                ]);

                const branch = branchResult.status === "fulfilled" ? branchResult.value.stdout.trim() : "";
                const statusOutput = statusResult.status === "fulfilled" ? statusResult.value.stdout : "";
                const diffStaged = diffStagedResult.status === "fulfilled" ? diffStagedResult.value.stdout : "";

                // Parse porcelain output
                const changes: Array<{ status: string; path: string; originalPath?: string }> = [];
                for (const line of statusOutput.split("\n")) {
                    if (!line.trim()) continue;
                    const xy = line.substring(0, 2);
                    const rest = line.substring(3);
                    // Handle renames: "R  old -> new"
                    const arrowIdx = rest.indexOf(" -> ");
                    if (arrowIdx >= 0) {
                        changes.push({
                            status: xy.trim(),
                            path: rest.substring(arrowIdx + 4),
                            originalPath: rest.substring(0, arrowIdx),
                        });
                    } else {
                        changes.push({ status: xy.trim(), path: rest });
                    }
                }

                // Get ahead/behind counts
                let ahead = 0;
                let behind = 0;
                if (abResult.status === "fulfilled") {
                    const abOutput = abResult.value.stdout.trim();
                    const [a, b] = abOutput.split(/\s+/);
                    ahead = parseInt(a, 10) || 0;
                    behind = parseInt(b, 10) || 0;
                }

                socket.emit("file_result", {
                    requestId,
                    ok: true,
                    branch,
                    changes,
                    ahead,
                    behind,
                    diffStaged,
                });
            } catch (err) {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("git_diff", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const cwd = data.cwd ?? "";
            const filePath = (data as any).path ?? "";
            const staged = (data as any).staged === true;

            if (!cwd || !filePath) {
                socket.emit("file_result", { requestId, ok: false, message: "Missing cwd or path" });
                return;
            }
            if (!isCwdAllowed(cwd)) {
                socket.emit("file_result", { requestId, ok: false, message: "Path outside allowed roots" });
                return;
            }
            try {
                const args = staged ? ["diff", "--cached", "--", filePath] : ["diff", "--", filePath];
                const { stdout: diff } = await execFileAsync("git", args, { cwd, timeout: 10000 });
                socket.emit("file_result", { requestId, ok: true, diff });
            } catch (err) {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        // ── Sandbox ────────────────────────────────────────────────────────

        socket.on("sandbox_get_status", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            try {
                // Read sandbox config from disk — the daemon process does NOT
                // run inside a sandbox itself, so process-local sandbox state
                // (getSandboxMode, isSandboxActive, getViolations) would always
                // return defaults.  The persisted config is the source of truth
                // for what workers will use.
                const { loadConfig, resolveSandboxConfig, loadGlobalConfig } = await import("../config.js");
                // Use only the global config for resolution — the daemon
                // process CWD may contain project-local overrides that
                // should not influence the global settings editor.
                const globalCfg = loadGlobalConfig();
                const globalOnlyConfig = loadConfig(process.cwd());
                // Override sandbox with global-only to prevent project-local
                // settings from leaking into the status response.
                globalOnlyConfig.sandbox = globalCfg.sandbox ?? {};
                const resolvedConfig = resolveSandboxConfig(process.cwd(), globalOnlyConfig);
                const mode = resolvedConfig.mode ?? "none";
                // The daemon can't know if a worker sandbox is actively
                // enforcing right now — report that a non-"none" mode is
                // *configured*, not that enforcement is proven active.
                const configured = mode !== "none";
                socket.emit("file_result", {
                    requestId,
                    ok: true,
                    mode,
                    active: configured,
                    configured,
                    platform: process.platform,
                    violations: 0,
                    recentViolations: [],
                    config: resolvedConfig,
                    // Send only the *global* raw config so the UI editor
                    // doesn't leak project-local overrides into global config
                    // when saving.
                    rawConfig: loadGlobalConfig().sandbox ?? {},
                });
            } catch (err) {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("sandbox_update_config", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const body = data.config;
            try {
                if (!body || typeof body !== "object") {
                    socket.emit("file_result", { requestId, ok: false, message: "Invalid sandbox config body" });
                    return;
                }
                const validModes = ["none", "basic", "full"];
                if (body.mode !== undefined && !validModes.includes(body.mode)) {
                    socket.emit("file_result", { requestId, ok: false, message: `Invalid mode "${body.mode}"` });
                    return;
                }
                const { saveGlobalConfig, loadConfig, resolveSandboxConfig, loadGlobalConfig } = await import("../config.js");
                // Merge with existing global sandbox config so UI-unmanaged
                // fields (ignoreViolations, allowUnixSockets, proxy ports,
                // allowGitConfig, etc.) are preserved across saves.
                const existingSandbox = loadGlobalConfig().sandbox ?? {} as Record<string, any>;
                // Deep-merge nested objects (filesystem, network) so that
                // sub-fields not managed by the UI (e.g. allowGitConfig,
                // allowUnixSockets, proxy ports) are preserved.
                const merged: Record<string, any> = { ...existingSandbox };
                for (const [key, value] of Object.entries(body)) {
                    if (value && typeof value === "object" && !Array.isArray(value)
                        && merged[key] && typeof merged[key] === "object" && !Array.isArray(merged[key])) {
                        merged[key] = { ...merged[key], ...value };
                    } else {
                        merged[key] = value;
                    }
                }
                saveGlobalConfig({ sandbox: merged });
                const newConfig = loadConfig(process.cwd());
                const resolved = resolveSandboxConfig(process.cwd(), newConfig);
                socket.emit("file_result", {
                    requestId,
                    ok: true,
                    saved: true,
                    resolvedConfig: resolved,
                    message: "Changes will apply on next session start.",
                });
            } catch (err) {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        // ── Error handling ────────────────────────────────────────────────

        socket.on("error", (data: any) => {
            logError(`server error: ${data.message}`);
        });
    });
}
