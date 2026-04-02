/**
 * Web exec command handler for the remote extension.
 *
 * Dispatches remote exec requests (from the web UI) to individual handlers.
 */

import { spawn } from "node:child_process";
import { buildSessionContext, SessionManager, type ExtensionContext, type SessionInfo } from "@mariozechner/pi-coding-agent";
import { getMcpBridge } from "./mcp-bridge.js";
import { toggleMcpServer, saveGlobalConfig, loadConfig, loadGlobalConfig, resolveSandboxConfig, type SandboxConfig } from "../config.js";
import { isPlanModeEnabled, togglePlanModeFromRemote, setPlanModeFromRemote } from "./plan-mode/index.js";
import { isSandboxActive, getSandboxMode, getViolations, getResolvedConfig } from "@pizzapi/tools";
import { refreshAllUsage, buildProviderUsage } from "./remote-provider-usage.js";
import type { RemoteExecRequest, RemoteExecResponse } from "./remote-commands.js";
import type { RelayContext, RelayModelInfo } from "./remote-types.js";
import { emitThinkingLevelChanged, emitCompactStarted, emitCompactEnded, emitRetryStateChanged, emitPluginTrustResolved } from "./remote-meta-events.js";
import { listSessionsCached } from "../runner/session-list-cache.js";

export interface ExecHandlerCallbacks {
    setModelFromWeb(provider: string, modelId: string): Promise<void>;
    markSessionNameBroadcasted(): void;
}

function listSessionsForResume(ctx: ExtensionContext): Promise<SessionInfo[]> {
    const sessionDir = ctx.sessionManager.getSessionDir();
    return listSessionsCached(sessionDir);
}

function pickResumeSession(sessions: SessionInfo[], currentPath: string | undefined, query?: string): SessionInfo | null {
    const normalized = query?.trim().toLowerCase();
    const candidates = sessions.filter((session) => session.path !== currentPath);
    if (candidates.length === 0) return null;

    if (!normalized) {
        return candidates[0] ?? null;
    }

    return (
        candidates.find((session) => {
            const id = session.id.toLowerCase();
            const path = session.path.toLowerCase();
            const name = (session.name ?? "").toLowerCase();
            const firstMessage = (session.firstMessage ?? "").toLowerCase();
            return (
                id.includes(normalized) ||
                path.includes(normalized) ||
                name.includes(normalized) ||
                firstMessage.includes(normalized)
            );
        }) ?? null
    );
}

function toResumeSessionSummary(session: SessionInfo) {
    return {
        id: session.id,
        path: session.path,
        name: session.name ?? null,
        modified: session.modified.toISOString(),
        firstMessage: session.firstMessage,
    };
}

export async function handleExecFromWeb(
    req: RemoteExecRequest,
    rctx: RelayContext,
    callbacks: ExecHandlerCallbacks,
): Promise<void> {
    const replyOk = (result?: unknown) =>
        rctx.sendToWeb({ type: "exec_result", id: req.id, ok: true, command: req.command, result });
    const replyErr = (error: string) =>
        rctx.sendToWeb({ type: "exec_result", id: req.id, ok: false, command: req.command, error });

    try {
        if (req.command === "get_commands") {
            const commands = (rctx.pi.getCommands?.() ?? []).map((c: any) => ({ name: c.name, description: c.description, source: c.source }));
            replyOk({ commands });
            return;
        }

        if (req.command === "mcp") {
            const bridge = getMcpBridge();
            if (!bridge) {
                replyErr("MCP extension is not initialized yet");
                return;
            }
            const action = req.action === "reload" ? "reload" : "status";
            const result = action === "reload" ? await bridge.reload() : bridge.status();
            replyOk({ ...result as object, action });
            return;
        }

        if (req.command === "mcp_toggle_server") {
            const bridge = getMcpBridge();
            if (!bridge) {
                replyErr("MCP extension is not initialized yet");
                return;
            }
            const { serverName, disabled } = req;
            if (!serverName || typeof serverName !== "string") {
                replyErr("Missing serverName");
                return;
            }
            const toggleResult = toggleMcpServer(serverName, disabled, process.cwd());
            if (toggleResult.globallyDisabled) {
                replyErr(`Cannot enable "${serverName}" — it is disabled in the global config (~/.pizzapi/config.json)`);
                return;
            }
            const snapshot = await bridge.reload();
            replyOk({ ...snapshot as object, action: "reload", toggledServer: serverName, disabled });
            return;
        }

        if (req.command === "abort") {
            if (!rctx.latestCtx) {
                replyErr("No active session");
                return;
            }
            rctx.wasAborted = true;
            rctx.latestCtx.abort();
            replyOk();
            rctx.forwardEvent(rctx.buildHeartbeat());
            return;
        }

        if (req.command === "set_model") {
            await callbacks.setModelFromWeb(req.provider, req.modelId);
            replyOk();
            return;
        }

        if (req.command === "cycle_model") {
            if (!rctx.latestCtx) {
                replyErr("No active session");
                return;
            }
            const models = rctx.getConfiguredModels();
            const state = rctx.buildSessionState();
            const currentKey = state?.model ? `${(state.model as any).provider}/${(state.model as any).id}` : null;
            const idx = currentKey ? models.findIndex((m: RelayModelInfo) => `${m.provider}/${m.id}` === currentKey) : -1;
            const next = models.length > 0 ? models[(idx + 1 + models.length) % models.length] : null;
            if (!next) {
                replyOk(null);
                return;
            }
            await callbacks.setModelFromWeb(next.provider, next.id);
            replyOk(next);
            return;
        }

        if (req.command === "get_available_models") {
            if (!rctx.latestCtx) {
                replyErr("No active session");
                return;
            }
            replyOk({ models: rctx.getConfiguredModels() });
            return;
        }

        if (req.command === "set_thinking_level") {
            const level = String((req as any).level ?? "").trim();
            if (!level) {
                replyErr("Missing level");
                return;
            }
            if (!rctx.latestCtx) {
                replyErr("No active session");
                return;
            }
            const api = rctx.pi as any;
            if (typeof api.setThinkingLevel !== "function" || typeof api.getThinkingLevel !== "function") {
                replyErr("Thinking level controls are not available in this pi version");
                return;
            }
            api.setThinkingLevel(level);
            emitThinkingLevelChanged(rctx, api.getThinkingLevel());
            replyOk({ thinkingLevel: api.getThinkingLevel() });
            rctx.emitSessionActive();
            return;
        }

        if (req.command === "cycle_thinking_level") {
            if (!rctx.latestCtx) {
                replyErr("No active session");
                return;
            }
            const api = rctx.pi as any;
            if (typeof api.setThinkingLevel !== "function" || typeof api.getThinkingLevel !== "function") {
                replyErr("Thinking level controls are not available in this pi version");
                return;
            }

            const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
            const current = String(api.getThinkingLevel() ?? "off");
            const startIdx = LEVELS.indexOf(current);

            let appliedLevel = current;
            for (let i = 1; i <= LEVELS.length; i++) {
                const candidate = LEVELS[((startIdx >= 0 ? startIdx : 0) + i) % LEVELS.length];
                api.setThinkingLevel(candidate);
                appliedLevel = String(api.getThinkingLevel() ?? candidate);
                if (appliedLevel !== current) break;
            }

            emitThinkingLevelChanged(rctx, appliedLevel);
            replyOk({ thinkingLevel: appliedLevel });
            rctx.emitSessionActive();
            return;
        }

        if (req.command === "set_steering_mode") {
            replyErr("set_steering_mode is not supported by the PizzaPi runner yet");
            return;
        }

        if (req.command === "set_follow_up_mode") {
            replyErr("set_follow_up_mode is not supported by the PizzaPi runner yet");
            return;
        }

        if (req.command === "set_plan_mode") {
            const explicitEnabled = (req as any).enabled;
            if (typeof explicitEnabled === "boolean") {
                const result = setPlanModeFromRemote(explicitEnabled);
                if (result === null) {
                    replyErr("Plan mode extension not initialized");
                    return;
                }
            } else {
                const toggled = togglePlanModeFromRemote();
                if (!toggled) {
                    replyErr("Plan mode extension not initialized");
                    return;
                }
            }
            const enabled = isPlanModeEnabled();
            replyOk({ planModeEnabled: enabled });
            rctx.forwardEvent(rctx.buildHeartbeat());
            return;
        }

        if (req.command === "refresh_usage") {
            await refreshAllUsage({ force: true });
            const providerUsage = buildProviderUsage();
            replyOk({ providerUsage, refreshedAt: Date.now() });
            rctx.forwardEvent(rctx.buildHeartbeat());
            return;
        }

        if (req.command === "compact") {
            if (!rctx.latestCtx) {
                replyErr("No active session");
                return;
            }
            if (rctx.isCompacting) {
                replyErr("Compaction already in progress");
                return;
            }
            rctx.isCompacting = true;
            emitCompactStarted(rctx);
            rctx.forwardEvent(rctx.buildHeartbeat());
            try {
                const result = await new Promise<unknown>((resolve, reject) => {
                    rctx.latestCtx!.compact({
                        customInstructions: req.customInstructions,
                        onComplete: (r) => resolve(r),
                        onError: (err) => reject(err),
                    });
                });
                rctx.isAgentActive = false;
                rctx.lastRetryableError = null;
                // compact_ended may already have been emitted by the
                // session_compact extension hook — only emit if still flagged.
                if (rctx.isCompacting) {
                    rctx.isCompacting = false;
                    emitCompactEnded(rctx);
                }
                emitRetryStateChanged(rctx, null);
                replyOk(result ?? null);
                rctx.emitSessionActive();
                rctx.forwardEvent(rctx.buildHeartbeat());
            } catch (err) {
                if (rctx.isCompacting) {
                    rctx.isCompacting = false;
                    emitCompactEnded(rctx);
                }
                rctx.forwardEvent(rctx.buildHeartbeat());
                throw err;
            }
            return;
        }

        if (req.command === "set_session_name") {
            if (typeof rctx.pi.setSessionName !== "function") {
                replyErr("setSessionName is not available in this pi version");
                return;
            }
            await rctx.pi.setSessionName(req.name);

            callbacks.markSessionNameBroadcasted();
            replyOk({ sessionName: rctx.getCurrentSessionName() ?? null });
            rctx.emitSessionActive();
            rctx.forwardEvent(rctx.buildHeartbeat());
            return;
        }

        if (req.command === "get_last_assistant_text") {
            if (!rctx.latestCtx) {
                replyErr("No active session");
                return;
            }
            const { messages } = buildSessionContext(
                rctx.latestCtx.sessionManager.getEntries(),
                rctx.latestCtx.sessionManager.getLeafId(),
            );
            const lastAssistant = [...messages].reverse().find((m: any) => m?.role === "assistant");
            const content = (lastAssistant as any)?.content;
            const text =
                typeof content === "string"
                    ? content
                    : Array.isArray(content)
                      ? content
                            .filter((c: any) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
                            .map((c: any) => c.text)
                            .join("")
                      : null;
            replyOk({ text });
            return;
        }

        if (req.command === "list_resume_sessions") {
            if (!rctx.latestCtx) {
                replyErr("No active session");
                return;
            }
            const sessions = await listSessionsForResume(rctx.latestCtx);
            const currentPath = rctx.latestCtx.sessionManager.getSessionFile();
            let candidates = sessions.filter((session) => session.path !== currentPath);

            // Cursor-based pagination: cursor is the ISO modified date of the last item in the previous page
            const cursor = typeof req.cursor === "string" ? req.cursor : undefined;
            if (cursor) {
                const cursorTime = new Date(cursor).getTime();
                // Sessions are sorted by modified desc — skip past the cursor
                const cursorIdx = candidates.findIndex((s) => s.modified.getTime() <= cursorTime);
                if (cursorIdx === -1) {
                    // Cursor is older than all sessions — nothing left
                    candidates = [];
                } else {
                    // Start from the item *after* the cursor match (skip items at exactly cursor time too,
                    // since they were included in the previous page)
                    let startIdx = cursorIdx;
                    // Skip all items with the exact cursor timestamp (they were in the previous page)
                    while (startIdx < candidates.length && candidates[startIdx].modified.getTime() === cursorTime) {
                        startIdx++;
                    }
                    candidates = candidates.slice(startIdx);
                }
            }

            const pageSize = typeof req.limit === "number" && req.limit > 0 ? Math.min(req.limit, 200) : 50;
            const page = candidates.slice(0, pageSize);
            const hasMore = candidates.length > pageSize;
            const nextCursor = hasMore && page.length > 0
                ? page[page.length - 1].modified.toISOString()
                : null;

            replyOk({
                currentPath: currentPath ?? null,
                sessions: page.map(toResumeSessionSummary),
                nextCursor,
            });
            return;
        }

        if (req.command === "resume_session") {
            if (!rctx.latestCtx) {
                replyErr("No active session");
                return;
            }
            if (typeof (rctx.pi as any).switchSession !== "function") {
                replyErr("switchSession is not available in this pi version");
                return;
            }
            const sessions = await listSessionsForResume(rctx.latestCtx);
            const currentPath = rctx.latestCtx.sessionManager.getSessionFile();
            const target = req.sessionPath
                ? sessions.find((session) => session.path === req.sessionPath) ?? null
                : pickResumeSession(sessions, currentPath, req.query);

            if (!target || target.path === currentPath) {
                replyErr("No other sessions found to resume");
                return;
            }
            try {
                const result = await (rctx.pi as any).switchSession(target.path);
                if (result?.cancelled) {
                    replyErr("Resume was cancelled");
                    return;
                }
            } catch (e) {
                replyErr(e instanceof Error ? e.message : String(e));
                return;
            }
            replyOk({ session: toResumeSessionSummary(target) });
            rctx.emitSessionActive();
            rctx.forwardEvent(rctx.buildHeartbeat());
            return;
        }

        if (req.command === "new_session") {
            if (!rctx.latestCtx) {
                replyErr("No active session");
                return;
            }
            try {
                const result = await (rctx.pi as any).newSession();
                if (result?.cancelled) {
                    replyErr("New session was cancelled");
                    return;
                }
            } catch (e) {
                replyErr(e instanceof Error ? e.message : String(e));
                return;
            }
            replyOk();
            rctx.emitSessionActive();
            return;
        }

        if (req.command === "end_session") {
            if (!rctx.latestCtx) {
                replyErr("No active session");
                return;
            }
            replyOk();
            rctx.shuttingDown = true;
            rctx.wasAborted = true;
            setTimeout(() => {
                rctx.latestCtx?.shutdown();
            }, 100);
            return;
        }

        if (req.command === "export_html") {
            replyErr("export_html is not implemented for remote exec yet");
            return;
        }

        if (req.command === "restart") {
            replyOk();
            setTimeout(() => {
                if (process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH) {
                    // Notify the daemon via IPC before exiting so it can mark this
                    // session as restarting *before* the relay's session_ended event
                    // arrives (which can beat child.on("exit") over the network).
                    // process.send is only defined when the daemon spawned us with an
                    // IPC channel; the optional call is a no-op in other contexts.
                    process.send?.({ type: "pre_restart" });
                    process.exit(43);
                    return;
                }
                const child = spawn(process.execPath, process.argv.slice(1), {
                    detached: true,
                    stdio: "inherit",
                    env: process.env,
                });
                child.unref();
                process.exit(0);
            }, 100);
            return;
        }

        if (req.command === "sandbox_get_status") {
            const mode = getSandboxMode();
            const active = isSandboxActive();
            const violations = getViolations();
            const resolvedConfig = getResolvedConfig();
            const recentViolations = violations.slice(-20).reverse().map((v) => ({
                timestamp: v.timestamp.toISOString(),
                operation: v.operation,
                target: v.target,
                reason: v.reason,
            }));
            replyOk({
                mode,
                active,
                platform: process.platform,
                violations: violations.length,
                recentViolations,
                config: resolvedConfig,
            });
            return;
        }

        if (req.command === "sandbox_update_config") {
            const body = req.config;
            if (!body || typeof body !== "object") {
                replyErr("Invalid sandbox config body");
                return;
            }
            // Validate mode
            const validModes = ["none", "basic", "full"];
            if (body.mode !== undefined && !validModes.includes(body.mode)) {
                replyErr(`Invalid mode "${body.mode}". Valid values: ${validModes.join(", ")}`);
                return;
            }
            // Deep-merge with existing global sandbox config so fields
            // not included in the request (e.g. allowGitConfig,
            // allowUnixSockets, proxy ports) are preserved.
            const existingGlobal = loadGlobalConfig();
            const existingSandbox = existingGlobal.sandbox ?? {} as Record<string, any>;
            const merged: Record<string, any> = { ...existingSandbox };
            for (const [key, value] of Object.entries(body)) {
                if (value === null || value === undefined) {
                    // Explicit null means "remove this key" — used when
                    // downgrading from full mode to clear stale network rules.
                    delete merged[key];
                } else if (value && typeof value === "object" && !Array.isArray(value)
                    && merged[key] && typeof merged[key] === "object" && !Array.isArray(merged[key])) {
                    merged[key] = { ...merged[key], ...value };
                } else {
                    merged[key] = value;
                }
            }
            saveGlobalConfig({ sandbox: merged });
            // Reload and resolve config to return the new resolved state
            const newConfig = loadConfig(process.cwd());
            const resolved = resolveSandboxConfig(process.cwd(), newConfig);
            replyOk({
                saved: true,
                resolvedConfig: resolved,
                message: "Changes will apply on next session start.",
            });
            return;
        }

        if (req.command === "plugin_trust_response") {
            if (!rctx.pendingPluginTrust) {
                replyErr("No pending plugin trust prompt (may have expired)");
                return;
            }
            if (req.promptId !== rctx.pendingPluginTrust.promptId) {
                replyErr("Prompt ID mismatch — this prompt may have expired");
                return;
            }
            const trusted = req.trusted === true;
            const resolvedPromptId = rctx.pendingPluginTrust.promptId;
            rctx.pendingPluginTrust.respond(trusted);
            rctx.pendingPluginTrust = null;
            emitPluginTrustResolved(rctx, resolvedPromptId);
            replyOk({ trusted });
            return;
        }

        replyErr(`Unknown exec command: ${String((req satisfies never as any).command)}`);
    } catch (e) {
        replyErr(e instanceof Error ? e.message : String(e));
    }
}
