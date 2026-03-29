import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { ServiceRegistry } from "./service-handler.js";
import { TerminalService } from "./services/terminal-service.js";
import { FileExplorerService } from "./services/file-explorer-service.js";
import { GitService } from "./services/git-service.js";
import { TunnelService } from "./services/tunnel-service.js";
import { discoverServices } from "./service-loader.js";
import { globalPluginDirs } from "../plugins/discover.js";
import { io, type Socket } from "socket.io-client";
import {
    SOCKET_PROTOCOL_VERSION,
    type RunnerClientToServerEvents,
    type RunnerServerToClientEvents,
} from "@pizzapi/protocol";
import { TunnelClient } from "@pizzapi/tunnel";
import { loadGlobalConfig, defaultAgentDir, expandHome, loadConfig } from "../config.js";
import { cleanupSessionAttachments, sweepOrphanedAttachments } from "../extensions/session-attachments.js";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { ServiceTriggerDef } from "@pizzapi/protocol";
import { setLogComponent, logInfo, logWarn, logError } from "./logger.js";
import { extractHookSummary } from "./hook-summary.js";
import { defaultStatePath, acquireStateAndIdentity, releaseStateLock } from "./runner-state.js";
import { startUsageRefreshLoop, stopUsageRefreshLoop } from "./runner-usage-cache.js";
import { getWorkspaceRoots, isCwdAllowed } from "./workspace.js";
import { type RunnerSession, spawnSession } from "./session-spawner.js";

import {
    scanGlobalSkills,
    readSkillContent,
    writeSkill,
    deleteSkill,
} from "../skills.js";

import {
    scanGlobalAgents,
    readAgentContent,
    writeAgent,
    deleteAgent,
} from "../agents.js";

import {
    scanAllPluginInfo,
} from "../plugins.js";

import {
    initUsage,
    triggerScan,
    getData as getUsageData,
    closeUsage,
} from "../usage/index.js";
import type { UsageRange } from "../usage/types.js";

// Re-export migration from shared module — used on daemon startup
import { migrateAgentDir } from "../migrations.js";

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

    // Migrate session storage from legacy locations into flat ~/.pizzapi/
    migrateAgentDir();

    // Initialize usage tracking
    initUsage();

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

        function toTunnelRelayUrl(raw: string): string {
            if (raw.startsWith("http://")) return `${raw.replace(/^http:\/\//, "ws://")}/_tunnel`;
            if (raw.startsWith("https://")) return `${raw.replace(/^https:\/\//, "wss://")}/_tunnel`;
            if (raw.startsWith("ws://") || raw.startsWith("wss://")) return `${raw}/_tunnel`;
            return `wss://${raw}/_tunnel`;
        }

        const sioUrl = normaliseRelayUrl(relayRaw);
        const tunnelRelayUrl = toTunnelRelayUrl(sioUrl);

        const runningSessions = new Map<string, RunnerSession>();
        // Sessions currently in the middle of a restart-in-place (exit code 43).
        // While a sessionId is in this set, the session_ended event arriving from the
        // relay (triggered when the new worker's registerTuiSession tears down the old
        // connection) must be ignored — the new worker is already live.
        const restartingSessions = new Set<string>();
        // Sessions that have been explicitly killed via kill_session.
        // Prevents a race where the worker calls process.exit(43) (restart-in-place)
        // before SIGTERM is delivered — without this guard, exit code 43 in the child's
        // exit handler would trigger doSpawn() even for an explicitly killed session,
        // creating a zombie re-spawn.
        const killedSessions = new Set<string>();
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
        let servicesInitialized = false;

        // ── Service registry ──────────────────────────────────────────────
        const registry = new ServiceRegistry();
        registry.register(new TerminalService());
        registry.register(new FileExplorerService());
        registry.register(new GitService());
        const tunnelService = new TunnelService();
        registry.register(tunnelService);

        const formatTunnelLog = (...args: unknown[]) => args.map((arg) => {
            if (typeof arg === "string") return arg;
            if (arg instanceof Error) return arg.stack ?? arg.message;
            return String(arg);
        }).join(" ");

        const tunnelClient = apiKey
            ? new TunnelClient({
                runnerId: identity.runnerId,
                apiKey,
                relayUrl: tunnelRelayUrl,
                log: {
                    info: (...args) => logInfo(formatTunnelLog(...args)),
                    debug: (...args) => logInfo(formatTunnelLog(...args)),
                    warn: (...args) => logWarn(formatTunnelLog(...args)),
                    error: (...args) => logError(formatTunnelLog(...args)),
                },
            })
            : null;
        let tunnelClientStarted = false;
        tunnelService.setTunnelClient(tunnelClient);

        // Panel tracking — manifests from folder-based services, ports from announcePanel()
        type PanelEntry = {
            serviceId: string;
            label: string;
            icon: string;
            port?: number;
            /** Trigger types declared in this service's manifest */
            triggers?: ServiceTriggerDef[];
        };
        const panelEntries = new Map<string, PanelEntry>();

        /** Emit service_announce with current service IDs, panel metadata, and trigger defs. */
        const emitServiceAnnounce = () => {
            const allServiceIds = registry.getAll().map((s) => s.id);
            const panels = Array.from(panelEntries.values())
                .filter((p): p is PanelEntry & { port: number } => p.port != null);
            // Collect all trigger defs across all services with manifests
            const allTriggerDefs: ServiceTriggerDef[] = [];
            for (const entry of panelEntries.values()) {
                if (entry.triggers && entry.triggers.length > 0) {
                    allTriggerDefs.push(...entry.triggers);
                }
            }
            (socket as any).emit("service_announce", {
                serviceIds: allServiceIds,
                ...(panels.length > 0 ? { panels } : {}),
                ...(allTriggerDefs.length > 0 ? { triggerDefs: allTriggerDefs } : {}),
            });
        };

        // Discover and register plugin-provided services.
        // pluginServicesReady resolves once discovery + registration is complete.
        // The runner_registered handler awaits this before announcing services.
        let resolvePluginServices: () => void;
        const pluginServicesReady = new Promise<void>(r => { resolvePluginServices = r; });
        discoverServices({ pluginDirs: globalPluginDirs() }).then(({ services, errors }) => {
            for (const { handler, source, manifest } of services) {
                try {
                    registry.register(handler);
                    logInfo(`[services] loaded plugin service "${handler.id}" from ${source.pluginName ?? source.path}`);
                    // Track panel metadata and trigger defs from folder-based services
                    if (manifest?.panel || (manifest?.triggers && manifest.triggers.length > 0)) {
                        const existing = panelEntries.get(handler.id);
                        panelEntries.set(handler.id, {
                            serviceId: handler.id,
                            label: manifest.label,
                            icon: manifest.icon,
                            ...(existing?.port !== undefined ? { port: existing.port } : {}),
                            ...(manifest.triggers && manifest.triggers.length > 0
                                ? { triggers: manifest.triggers }
                                : {}),
                        });
                    }
                } catch (err) {
                    logWarn(`[services] failed to register plugin service "${handler.id}": ${err}`);
                }
            }
            for (const { path, error } of errors) {
                logWarn(`[services] plugin service load error at ${path}: ${error}`);
            }
        }).catch(err => {
            logWarn(`[services] plugin service discovery failed: ${err}`);
        }).finally(() => {
            resolvePluginServices!();
        });

        const socket: Socket<RunnerServerToClientEvents, RunnerClientToServerEvents> = io(
            sioUrl + "/runner",
            {
                auth: {
                    apiKey,
                    runnerId: identity.runnerId,
                    runnerSecret: identity.runnerSecret,
                    protocolVersion: SOCKET_PROTOCOL_VERSION,
                    ...(cliVersion ? { clientVersion: cliVersion } : {}),
                },
                transports: ["websocket"],
                reconnection: true,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 30000,
            },
        );

        // Service init happens in runner_registered after plugin discovery completes.

        if (tunnelClient) {
            tunnelClient.on("registered", () => {
                logInfo(`[tunnel] registered at ${tunnelRelayUrl}`);
                tunnelService.setTunnelClient(tunnelClient);
                // Clear any previous tunnel warning now that we're connected
                socket.emit("runner_warning_clear", {} as Record<string, never>);
            });
            tunnelClient.on("disconnect", () => {
                if (!isShuttingDown) {
                    logInfo(`[tunnel] disconnected from ${tunnelRelayUrl}`);
                }
            });
            tunnelClient.on("error", (error) => {
                logError(`[tunnel] ${error instanceof Error ? error.message : String(error)}`);
            });
            tunnelClient.on("disabled", (data: { reason: string; failures: number; relayUrl: string }) => {
                logWarn(`[tunnel] disabled after ${data.failures} failed connection attempts to ${data.relayUrl}`);
                logWarn("[tunnel] The relay server may not support the /_tunnel endpoint. Upgrade the server with 'pizza web'.");
                // Surface as a visible warning in the web UI
                socket.emit("runner_warning", {
                    message: "Tunnel unavailable — the relay server does not support the tunnel endpoint. Upgrade with 'pizza web' to enable tunnels and service panels.",
                });
            });
        } else {
            logWarn("[tunnel] disabled: runner is missing an API key for tunnel authentication");
        }

        logInfo(`connecting to relay at ${sioUrl}/runner…`);

        // Start periodic usage scan (every 5 minutes)
        const usageScanInterval = setInterval(() => {
            triggerScan();
        }, 5 * 60 * 1000);

        const shutdown = (code: number) => {
            if (isShuttingDown) return;
            isShuttingDown = true;
            clearInterval(endedSessionSweep);
            clearInterval(usageScanInterval);
            tunnelClient?.dispose();
            registry.disposeAll();
            stopUsageRefreshLoop();
            closeUsage();
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
            if (tunnelClient && !tunnelClientStarted) {
                tunnelClientStarted = true;
                tunnelClient.connect();
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

        socket.on("runner_registered", async (data: any) => {
            // Fix 3 (P2): wrap the entire handler in try/catch so that any
            // service init() error doesn't silently swallow and leave the
            // daemon in a half-initialized state.
            try {
                runnerId = data.runnerId;
                if (runnerId !== identity.runnerId) {
                    logWarn(`server assigned unexpected ID ${runnerId} (expected ${identity.runnerId})`);
                }
                logInfo(`registered as ${runnerId}`);

                // Wait for plugin service discovery to finish, then init ALL services
                // (built-in + plugins) and announce the full list.
                // On reconnect, dispose first to clear stale listeners from the old socket.
                await pluginServicesReady;
                if (servicesInitialized) {
                    registry.disposeAll();
                }
                servicesInitialized = true;
                // Build announcePanel callback — when a service calls it, we register
                // the port with the tunnel service and re-announce to viewers.
                const announcePanel = (serviceId: string) => (port: number) => {
                    const entry = panelEntries.get(serviceId);
                    if (!entry) return;
                    entry.port = port;
                    tunnelService.registerPort(port, entry.label);
                    logInfo(`[services] panel announced for "${serviceId}" on port ${port}`);
                    // Re-announce so viewers pick up the panel
                    emitServiceAnnounce();
                };

                // Init all services — pass announcePanel to those with panel manifests
                for (const handler of registry.getAll()) {
                    const opts: any = { isShuttingDown: () => isShuttingDown };
                    if (panelEntries.has(handler.id)) {
                        opts.announcePanel = announcePanel(handler.id);
                    }
                    handler.init(socket, opts);
                }
                const allServiceIds = registry.getAll().map((s) => s.id);
                logInfo(`[services] initialized ${allServiceIds.length} services: ${allServiceIds.join(", ")}`);

                // TunnelService now preserves its exposed-port state across Socket.IO
                // reconnects and re-announces known ports when re-initialized.
                emitServiceAnnounce();

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
            } catch (err) {
                logError(`[daemon] runner_registered handler failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
            }
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
                    spawnSession(sessionId, apiKey!, relayRaw, requestedCwd, runningSessions, restartingSessions, killedSessions, doSpawn, spawnOpts);
                    socket.emit("session_ready", { sessionId });
                    // No need to re-emit service_announce here — the server
                    // persists the announce data in Redis and sends it to
                    // viewers automatically when they connect to a session.
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
                        // Mark as killed BEFORE sending SIGTERM so the child's
                        // exit handler sees it even if exit code 43 (restart-in-place)
                        // arrives before SIGTERM is delivered.
                        killedSessions.add(sessionId);
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
                killedSessions.delete(sessionId);
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

        // ── Usage dashboard ───────────────────────────────────────────────

        // ── Models ──────────────────────────────────────────────────────

        socket.on("list_models", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data?.requestId;
            try {
                const config = loadConfig(process.cwd());
                const agentDir = config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();
                const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
                const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
                const models = modelRegistry
                    .getAvailable()
                    .map((model: any) => ({
                        provider: model.provider,
                        id: model.id,
                        name: model.name,
                        reasoning: model.reasoning,
                        contextWindow: model.contextWindow,
                    }))
                    .sort((a: any, b: any) => {
                        if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
                        return a.id.localeCompare(b.id);
                    });
                socket.emit("models_list", { requestId, models });
            } catch (e: any) {
                socket.emit("models_list", { requestId, models: [], error: e.message ?? "Failed to list models" });
            }
        });

        // ── Usage ─────────────────────────────────────────────────────────

        socket.on("get_usage", (data: any) => {
            if (isShuttingDown) return;
            const requestId = data.requestId ?? "";
            try {
                const range = (data.range as UsageRange) || "90d";
                const usageData = getUsageData(range);
                if (!usageData) {
                    socket.emit("usage_error", {
                        requestId,
                        error: "Usage data not available yet — initial scan in progress",
                    });
                    return;
                }
                socket.emit("usage_data", { requestId, data: usageData });
            } catch (e: any) {
                socket.emit("usage_error", {
                    requestId,
                    error: e.message ?? "Unknown error",
                });
            }
        });

        // ── Settings ───────────────────────────────────────────────────────

        socket.on("settings_get_config", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data?.requestId;
            try {
                const { loadGlobalConfig: loadGlobal } = await import("../config.js");
                const globalConfig = loadGlobal();

                // Also read settings.json (TUI preferences)
                const settingsPath = join(homedir(), ".pizzapi", "settings.json");
                let tuiSettings: Record<string, unknown> = {};
                try {
                    const { readFileSync, existsSync } = await import("fs");
                    if (existsSync(settingsPath)) {
                        tuiSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
                    }
                } catch {
                    // settings.json may not exist yet
                }

                // Also read ~/.pizzapi/AGENTS.md
                const agentsMdPath = join(homedir(), ".pizzapi", "AGENTS.md");
                let agentsMd = "";
                try {
                    const { readFileSync, existsSync } = await import("fs");
                    if (existsSync(agentsMdPath)) {
                        agentsMd = readFileSync(agentsMdPath, "utf-8");
                    }
                } catch {
                    // AGENTS.md may not exist yet
                }

                socket.emit("file_result", {
                    requestId,
                    ok: true,
                    config: globalConfig,
                    tuiSettings,
                    agentsMd,
                });
            } catch (err) {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("settings_update_section", async (data: any) => {
            if (isShuttingDown) return;
            const requestId = data?.requestId;
            const section = data?.section;
            const value = data?.value;
            try {
                if (!section || typeof section !== "string") {
                    socket.emit("file_result", { requestId, ok: false, message: "Missing section name" });
                    return;
                }

                // Handle AGENTS.md separately — it's a standalone file, not JSON config
                if (section === "agentsMd") {
                    const agentsMdPath = join(homedir(), ".pizzapi", "AGENTS.md");
                    const { writeFileSync, mkdirSync, existsSync } = await import("fs");
                    const dir = join(homedir(), ".pizzapi");
                    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                    const content = typeof value === "string" ? value : "";
                    writeFileSync(agentsMdPath, content, "utf-8");
                    socket.emit("file_result", {
                        requestId,
                        ok: true,
                        saved: true,
                        message: "AGENTS.md saved. Changes apply on next session start.",
                    });
                    return;
                }

                // Sections that go into settings.json (TUI preferences)
                const tuiSections = new Set(["tuiPreferences", "models"]);

                if (tuiSections.has(section)) {
                    // Read/merge/write settings.json
                    const settingsPath = join(homedir(), ".pizzapi", "settings.json");
                    const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import("fs");
                    const dir = join(homedir(), ".pizzapi");
                    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                    let existing: Record<string, unknown> = {};
                    try {
                        if (existsSync(settingsPath)) {
                            existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
                        }
                    } catch { /* start fresh */ }

                    // Merge TUI settings at top level
                    if (value && typeof value === "object" && !Array.isArray(value)) {
                        Object.assign(existing, value);
                    }
                    writeFileSync(settingsPath, JSON.stringify(existing, null, 2), "utf-8");
                    socket.emit("file_result", {
                        requestId,
                        ok: true,
                        saved: true,
                        message: "TUI settings saved. Changes apply on next session start.",
                    });
                } else {
                    // All other sections go into config.json
                    const { saveGlobalConfig: saveGlobal, loadGlobalConfig: loadGlobal } = await import("../config.js");

                    // Map section names to config.json keys
                    const sectionToConfigKey: Record<string, string> = {
                        mcpServers: "mcpServers",
                        hooks: "hooks",
                        sandbox: "sandbox",
                        webSearch: "providerSettings",
                        security: "_security",        // virtual — handled specially
                        envVars: "_envVars",          // virtual — handled specially
                        systemPrompt: "_systemPrompt", // virtual — handled specially
                    };

                    const configKey = sectionToConfigKey[section] ?? section;
                    const existing = loadGlobal();

                    if (section === "security") {
                        const v = value as any;
                        const updates: Record<string, any> = {};
                        if (v?.allowProjectHooks !== undefined) updates.allowProjectHooks = v.allowProjectHooks;
                        if (v?.trustedPlugins !== undefined) updates.trustedPlugins = v.trustedPlugins;
                        saveGlobal(updates);
                    } else if (section === "systemPrompt") {
                        const v = value as any;
                        const updates: Record<string, any> = {};
                        if (v?.appendSystemPrompt !== undefined) updates.appendSystemPrompt = v.appendSystemPrompt;
                        if (v?.skills !== undefined) updates.skills = v.skills;
                        saveGlobal(updates);
                    } else if (section === "envVars") {
                        // Env vars are stored in a custom key in config.json
                        const updates: Record<string, any> = { envOverrides: value };
                        saveGlobal(updates);
                    } else if (section === "webSearch") {
                        // Web search config goes into providerSettings
                        const v = value as any;
                        const ps = (existing as any).providerSettings ?? {};
                        if (v?.anthropic?.webSearch) {
                            ps.anthropic = { ...ps.anthropic, webSearch: v.anthropic.webSearch };
                        }
                        saveGlobal({ providerSettings: ps } as any);
                    } else {
                        // Direct key mapping
                        saveGlobal({ [configKey]: value } as any);
                    }

                    // Reload and return the updated config
                    const updatedConfig = loadGlobal();
                    socket.emit("file_result", {
                        requestId,
                        ok: true,
                        saved: true,
                        config: updatedConfig,
                        message: "Settings saved. Changes apply on next session start.",
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

        // ── Error handling ────────────────────────────────────────────────

        socket.on("error", (data: any) => {
            logError(`server error: ${data.message}`);
        });
    });
}
