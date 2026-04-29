/**
 * Runners router — runner management, session spawn, skills, files.
 *
 * Git operations are handled via the service_message channel (see git-service.ts).
 * This is the largest router. If it exceeds 500 lines, split into sub-modules
 * (runners-core.ts, runners-skills.ts, runners-files.ts).
 */

import {
    getRunnerData,
    getRunners,
    getLocalRunnerSocket,
    getLocalTuiSocket,
    getConnectedSessionsForRunner,
    linkSessionToRunner,
    recordRunnerSession,
    registerTerminal,
} from "../ws/sio-registry.js";
import { getRunnerServices } from "../ws/sio-registry/runners.js";
import {
    addRunnerTriggerListener,
    getRunnerTriggerListener,
    removeRunnerTriggerListener,
    listRunnerTriggerListeners,
    updateRunnerTriggerListener,
} from "../sessions/runner-trigger-listener-store.js";
import { getSession } from "../ws/sio-state/index.js";
import { sendSkillCommand, sendAgentCommand, sendRunnerCommand, emitTriggerSubscriptionDelta } from "../ws/namespaces/runner.js";
import { waitForSpawnAck } from "../ws/runner-control.js";
import { requireSession, validateApiKey } from "../middleware.js";
import { deleteRecentFolder, getRecentFolders, recordRecentFolder } from "../runner-recent-folders.js";
import { getHiddenModels } from "../user-hidden-models.js";
import { cwdMatchesRoots } from "../security.js";
import { isValidSkillName } from "../validation.js";
import { parseJsonArray } from "./utils.js";
import { isHiddenModel } from "./model-guard.js";
import type { RouteHandler } from "./types.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("runners");
const skillsLog = createLogger("skills");
const agentsLog = createLogger("agents");
const pluginsLog = createLogger("plugins");

function runnerListenerAsSubscription(runnerId: string, listener: {
    listenerId?: string;
    triggerType: string;
    params?: Record<string, unknown>;
}) {
    return {
        subscriptionId: listener.listenerId ?? `runner-listener:${runnerId}:${listener.triggerType}`,
        sessionId: `runner-listener:${listener.listenerId ?? listener.triggerType}`,
        runnerId,
        triggerType: listener.triggerType,
        ...(listener.params ? { params: listener.params as Record<string, string | number | boolean | Array<string | number | boolean>> } : {}),
    };
}

const RUNNER_MCP_RELOAD_RE = /^\/api\/runners\/([^/]+)\/mcp\/reload$/;

export const handleRunnersRoute: RouteHandler = async (req, url) => {
    // ── List runners ───────────────────────────────────────────────────
    if (url.pathname === "/api/runners" && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;
        return Response.json({ runners: await getRunners(identity.userId) });
    }

    // ── Spawn session ──────────────────────────────────────────────────
    if (url.pathname === "/api/runners/spawn" && req.method === "POST") {
        const providedApiKey = req.headers.get("x-api-key") ?? undefined;
        const identity = providedApiKey
            ? await validateApiKey(req, providedApiKey)
            : await requireSession(req);
        if (identity instanceof Response) return identity;

        let body: any = {};
        try { body = await req.json(); } catch { body = {}; }

        const requestedRunnerId = typeof body.runnerId === "string" ? body.runnerId : undefined;
        const requestedCwd = typeof body.cwd === "string" ? body.cwd : undefined;
        const requestedPrompt = typeof body.prompt === "string" ? body.prompt : undefined;
        const requestedResumePath = typeof body.resumePath === "string" ? body.resumePath : undefined;
        const requestedResumeId = typeof body.resumeId === "string" ? body.resumeId : undefined;

        // Normalize requested model fields. Whitespace is trimmed to match the
        // worker-side normalization in initial-prompt.ts (env vars are .trim()'d
        // before modelRegistry lookup).
        let requestedModel: { provider: string; id: string } | undefined;
        if (body.model && typeof body.model === "object") {
            const provider = (body.model as any).provider;
            const id = (body.model as any).id;
            if (typeof provider === "string" && typeof id === "string") {
                const normalizedProvider = provider.trim();
                const normalizedId = id.trim();
                if (normalizedProvider && normalizedId) {
                    requestedModel = { provider: normalizedProvider, id: normalizedId };
                }
            }
        }

        // Optional agent config — spawn the session "as" this agent.
        // Validate the agent name to prevent path traversal — only allow names
        // that match the pattern used by agent file discovery (letters, digits,
        // hyphens, underscores, dots — no path separators).
        const rawAgentName = body.agent && typeof body.agent === "object" && typeof (body.agent as any).name === "string"
            ? ((body.agent as any).name as string).trim()
            : undefined;
        if (rawAgentName && !isValidSkillName(rawAgentName)) {
            return Response.json({ error: "Invalid agent name" }, { status: 400 });
        }
        const requestedAgent = rawAgentName
                ? {
                    name: rawAgentName,
                    systemPrompt: typeof (body.agent as any).systemPrompt === "string" ? (body.agent as any).systemPrompt as string : undefined,
                    tools: typeof (body.agent as any).tools === "string" ? (body.agent as any).tools as string : undefined,
                    disallowedTools: typeof (body.agent as any).disallowedTools === "string" ? (body.agent as any).disallowedTools as string : undefined,
                }
                : undefined;

        const requestedParentSessionId = typeof body.parentSessionId === "string" ? body.parentSessionId : undefined;

        if (!requestedRunnerId) {
            return Response.json({ error: "Missing runnerId" }, { status: 400 });
        }

        const runnerId = requestedRunnerId;
        const runner = await getRunnerData(runnerId);
        if (!runner) {
            return Response.json({ error: "Runner not found" }, { status: 404 });
        }
        if (!runner.userId) {
            return Response.json({ error: "Runner is not associated with a user" }, { status: 403 });
        }
        if (runner.userId !== identity.userId) {
            return Response.json({ error: "Forbidden" }, { status: 403 });
        }

        if (requestedCwd) {
            const roots = parseJsonArray(runner.roots);
            if (roots.length > 0 && !cwdMatchesRoots(roots, requestedCwd)) {
                return Response.json({ error: `Runner cannot access cwd: ${requestedCwd}` }, { status: 400 });
            }
        }

        // Block spawns that explicitly request a hidden model.
        // Hidden models are filtered from list_models output but must also be
        // enforced as a hard block here so they can't be reached by name.
        // This check runs before the socket lookup so we reject cheaply.
        let hiddenModels: string[];
        try {
            hiddenModels = await getHiddenModels(identity.userId);
        } catch (err) {
            log.error("Failed to fetch hidden models for user", identity.userId, err);
            return Response.json({ error: "Unable to validate model availability" }, { status: 500 });
        }

        if (requestedModel && isHiddenModel(hiddenModels, requestedModel)) {
            return Response.json({ error: "Requested model is not available" }, { status: 400 });
        }

        const runnerSocket = getLocalRunnerSocket(runnerId);
        if (!runnerSocket) {
            return Response.json({ error: "Runner is not connected to this server" }, { status: 502 });
        }

        const sessionId = crypto.randomUUID();

        // Validate parentSessionId ownership BEFORE forwarding to the runner.
        // The worker activates child trigger mode from the parent ID it receives,
        // so we must never send an unverified/cross-user parent ID.
        let validatedParentSessionId: string | undefined;
        if (requestedParentSessionId) {
            const parentSession = await getSession(requestedParentSessionId);
            if (parentSession && parentSession.userId === identity.userId) {
                validatedParentSessionId = requestedParentSessionId;
            }
        }

        const ackPromise = waitForSpawnAck(sessionId, 5_000);

        try {
            runnerSocket.emit("new_session", {
                sessionId,
                cwd: requestedCwd,
                ...(requestedPrompt ? { prompt: requestedPrompt } : {}),
                ...(requestedModel ? { model: requestedModel } : {}),
                ...(hiddenModels.length > 0 ? { hiddenModels } : {}),
                ...(requestedAgent ? { agent: requestedAgent } : {}),
                ...(validatedParentSessionId ? { parentSessionId: validatedParentSessionId } : {}),
                ...(requestedResumePath ? { resumePath: requestedResumePath } : {}),
                ...(requestedResumeId && !requestedResumePath ? { resumeId: requestedResumeId } : {}),
            });
        } catch {
            return Response.json({ error: "Failed to send spawn request to runner" }, { status: 502 });
        }

        const ack = await ackPromise;
        if (ack.ok === false && !(ack as any).timeout) {
            return Response.json({ error: ack.message }, { status: 400 });
        }

        await recordRunnerSession(runnerId, sessionId);
        await linkSessionToRunner(runnerId, sessionId);

        // Parent-child linking is now handled at registration time:
        // the worker sends parentSessionId in its relay `register` event,
        // and registerTuiSession stores the relationship + calls addChildSession.
        // No pre-seeding needed — eliminates the race condition.

        // Only record for top-level user-initiated spawns (not child/linked sessions).
        if (requestedCwd && !validatedParentSessionId) {
            void recordRecentFolder(identity.userId, runnerId, requestedCwd).catch(() => {});
        }

        return Response.json({ ok: true, runnerId, sessionId, pending: (ack as any).timeout === true });
    }

    // ── Reload MCP in active sessions for a runner ─────────────────────
    {
        const match = url.pathname.match(RUNNER_MCP_RELOAD_RE);
        if (match && req.method === "POST") {
            const identity = await requireSession(req);
            if (identity instanceof Response) return identity;

            const runnerId = decodeURIComponent(match[1]);
            const runner = await getRunnerData(runnerId);
            if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
            if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

            const connectedSessions = await getConnectedSessionsForRunner(runnerId);
            const reloadedSessionIds: string[] = [];
            const failedSessionIds: string[] = [];

            for (const { sessionId } of connectedSessions) {
                const tuiSocket = getLocalTuiSocket(sessionId);
                if (!tuiSocket) {
                    failedSessionIds.push(sessionId);
                    continue;
                }
                try {
                    tuiSocket.emit("exec" as string, {
                        type: "exec",
                        id: crypto.randomUUID(),
                        command: "mcp",
                        action: "reload",
                    });
                    reloadedSessionIds.push(sessionId);
                } catch {
                    failedSessionIds.push(sessionId);
                }
            }

            return Response.json({
                ok: true,
                reloaded: reloadedSessionIds.length,
                failed: failedSessionIds.length,
                sessionIds: reloadedSessionIds,
                failedSessionIds,
            });
        }
    }

    // ── Restart runner ─────────────────────────────────────────────────
    if (url.pathname === "/api/runners/restart" && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        let body: any = {};
        try { body = await req.json(); } catch { body = {}; }

        const runnerId = typeof body.runnerId === "string" ? body.runnerId : undefined;
        if (!runnerId) {
            return Response.json({ error: "Missing runnerId" }, { status: 400 });
        }

        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        const runnerSocket = getLocalRunnerSocket(runnerId);
        if (!runnerSocket) return Response.json({ error: "Runner is not connected to this server" }, { status: 502 });

        try { runnerSocket.emit("restart", {}); } catch {
            return Response.json({ error: "Failed to send restart request to runner" }, { status: 502 });
        }

        return Response.json({ ok: true });
    }

    // ── Stop runner ────────────────────────────────────────────────────
    if (url.pathname === "/api/runners/stop" && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        let body: any = {};
        try { body = await req.json(); } catch { body = {}; }

        const runnerId = typeof body.runnerId === "string" ? body.runnerId : undefined;
        if (!runnerId) return Response.json({ error: "Missing runnerId" }, { status: 400 });

        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        const runnerSocket = getLocalRunnerSocket(runnerId);
        if (!runnerSocket) return Response.json({ error: "Runner is not connected to this server" }, { status: 502 });

        try { runnerSocket.emit("shutdown", {}); } catch {
            return Response.json({ error: "Failed to send shutdown request to runner" }, { status: 502 });
        }

        return Response.json({ ok: true });
    }

    // ── Terminal creation ──────────────────────────────────────────────
    if (url.pathname === "/api/runners/terminal" && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        let body: any = {};
        try { body = await req.json(); } catch { body = {}; }

        const runnerId = typeof body.runnerId === "string" ? body.runnerId : undefined;
        const requestedCwd = typeof body.cwd === "string" ? body.cwd : undefined;
        const cols = typeof body.cols === "number" ? body.cols : 80;
        const rows = typeof body.rows === "number" ? body.rows : 24;

        if (!runnerId) return Response.json({ error: "Missing runnerId" }, { status: 400 });

        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (!runner.userId || runner.userId !== identity.userId) {
            return Response.json({ error: "Forbidden" }, { status: 403 });
        }

        if (requestedCwd) {
            const roots = parseJsonArray(runner.roots);
            if (roots.length > 0 && !cwdMatchesRoots(roots, requestedCwd)) {
                return Response.json({ error: `Runner cannot access cwd: ${requestedCwd}` }, { status: 400 });
            }
        }

        const terminalId = crypto.randomUUID();
        await registerTerminal(terminalId, runnerId, identity.userId, {
            cwd: requestedCwd,
            cols,
            rows,
        });

        return Response.json({ ok: true, terminalId, runnerId });
    }

    // ── Recent folders ─────────────────────────────────────────────────
    const recentFoldersMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/recent-folders$/);
    if (recentFoldersMatch) {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(recentFoldersMatch[1]);
        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        if (req.method === "GET") {
            const folders = await getRecentFolders(identity.userId, runnerId);
            return Response.json({ folders });
        }

        if (req.method === "DELETE") {
            const body = await req.json().catch(() => null) as Record<string, unknown> | null;
            const path = typeof body?.path === "string" ? body.path : "";
            if (!path) return Response.json({ error: "Missing path" }, { status: 400 });
            const deleted = await deleteRecentFolder(identity.userId, runnerId, path);
            return Response.json({ ok: true, deleted });
        }

        return undefined;
    }

    // ── Browse directory (folder picker) ───────────────────────────
    const browseMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/browse$/);
    if (browseMatch && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(browseMatch[1]);
        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        const path = url.searchParams.get("path") || "/";

        // Enforce workspace roots at the server layer (defense-in-depth).
        const roots = parseJsonArray(runner.roots);
        if (roots.length > 0 && !cwdMatchesRoots(roots, path)) {
            return Response.json({ error: "Path outside allowed workspace roots" }, { status: 400 });
        }

        try {
            const result = await sendRunnerCommand(runnerId, {
                type: "browse_directory",
                path,
            }, 10_000) as any;
            if (!result.ok) {
                return Response.json({ error: result.message || "Browse failed" }, { status: 400 });
            }
            return Response.json({ directories: result.directories ?? [] });
        } catch (err) {
            return Response.json(
                { error: err instanceof Error ? err.message : "Browse failed" },
                { status: 502 },
            );
        }
    }

    // ── Available models ───────────────────────────────────────────
    const modelsMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/models$/);
    if (modelsMatch && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(modelsMatch[1]);
        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        try {
            const result = await sendRunnerCommand(runnerId, { type: "list_models" }) as any;
            const models = Array.isArray(result?.models) ? result.models : [];
            // Filter out hidden models
            let hiddenModels: string[];
            try {
                hiddenModels = await getHiddenModels(identity.userId);
            } catch {
                hiddenModels = [];
            }
            const visible = models.filter((m: any) =>
                !hiddenModels.includes(`${m.provider}/${m.id}`)
            );
            return Response.json({ models: visible });
        } catch {
            return Response.json({ models: [] });
        }
    }

    // ── Runner services ─────────────────────────────────────────────
    const servicesMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/services$/);
    if (servicesMatch && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(servicesMatch[1]);
        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        const services = await getRunnerServices(runnerId);
        return Response.json({
            serviceIds: services?.serviceIds ?? [],
            panels: services?.panels ?? [],
            triggerDefs: services?.triggerDefs ?? [],
            sigilDefs: services?.sigilDefs ?? [],
        });
    }

    // ── Trigger definitions + listeners ──────────────────────────────
    const triggersMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/triggers$/);
    if (triggersMatch && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(triggersMatch[1]);
        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        const [services, listeners] = await Promise.all([
            getRunnerServices(runnerId),
            listRunnerTriggerListeners(runnerId),
        ]);
        return Response.json({
            triggerDefs: services?.triggerDefs ?? [],
            listeners,
        });
    }

    // ── Runner trigger listeners (subscribe/unsubscribe) ──────────────
    const listenerMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/trigger-listeners(?:\/([^/]+))?$/);
    if (listenerMatch) {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(listenerMatch[1]);
        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        // GET /api/runners/:id/trigger-listeners — list
        if (req.method === "GET" && !listenerMatch[2]) {
            const listeners = await listRunnerTriggerListeners(runnerId);
            return Response.json({ listeners });
        }

        // POST /api/runners/:id/trigger-listeners — add
        if (req.method === "POST" && !listenerMatch[2]) {
            const body = await req.json().catch(() => null) as Record<string, unknown> | null;
            const triggerType = typeof body?.triggerType === "string" ? body.triggerType.trim() : "";
            if (!triggerType) return Response.json({ error: "Missing triggerType" }, { status: 400 });

            const params = body?.params && typeof body.params === "object" && !Array.isArray(body.params)
                ? body.params as Record<string, unknown>
                : undefined;
            const model = body?.model && typeof body.model === "object" && !Array.isArray(body.model)
                && typeof (body.model as Record<string, unknown>).provider === "string"
                && typeof (body.model as Record<string, unknown>).id === "string"
                ? body.model as { provider: string; id: string }
                : undefined;
            if (model) {
                try {
                    const hiddenModels = await getHiddenModels(identity.userId);
                    if (isHiddenModel(hiddenModels, model)) {
                        return Response.json({ error: "Model is hidden and cannot be used" }, { status: 403 });
                    }
                } catch {
                }
            }

            const autoClose = body?.autoClose === true ? true : undefined;

            const listenerId = await addRunnerTriggerListener(runnerId, triggerType, {
                prompt: typeof body?.prompt === "string" ? body.prompt : undefined,
                cwd: typeof body?.cwd === "string" ? body.cwd : undefined,
                model,
                params,
                autoClose,
            });
            if (!listenerId) {
                return Response.json({ error: "Failed to create trigger listener" }, { status: 500 });
            }
            await emitTriggerSubscriptionDelta(runnerId, {
                action: "subscribe",
                subscription: runnerListenerAsSubscription(runnerId, {
                    listenerId,
                    triggerType,
                    params,
                }),
            }).catch((err) => {
                log.warn("Failed to emit runner listener subscribe delta:", err);
            });
            return Response.json({ ok: true, listenerId, triggerType });
        }

        if (req.method === "PUT" && listenerMatch[2]) {
            const target = decodeURIComponent(listenerMatch[2]);
            const body = await req.json().catch(() => null) as Record<string, unknown> | null;
            if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });

            const params = body.params && typeof body.params === "object" && !Array.isArray(body.params)
                ? body.params as Record<string, unknown>
                : undefined;
            const model = body.model && typeof body.model === "object" && !Array.isArray(body.model)
                && typeof (body.model as Record<string, unknown>).provider === "string"
                && typeof (body.model as Record<string, unknown>).id === "string"
                ? body.model as { provider: string; id: string }
                : undefined;
            if (model) {
                try {
                    const hiddenModels = await getHiddenModels(identity.userId);
                    if (isHiddenModel(hiddenModels, model)) {
                        return Response.json({ error: "Model is hidden and cannot be used" }, { status: 403 });
                    }
                } catch { }
            }

            const autoClose = typeof body.autoClose === "boolean" ? body.autoClose : undefined;

            const updated = await updateRunnerTriggerListener(runnerId, target, {
                prompt: typeof body.prompt === "string" ? body.prompt : undefined,
                cwd: typeof body.cwd === "string" ? body.cwd : undefined,
                model,
                params,
                autoClose,
            }) as any;

            if (!updated || updated.updated === false) {
                return Response.json({ error: `No listener for target '${target}'` }, { status: 404 });
            }

            const triggerType = updated.triggerType ?? target;
            const listenerId = updated.listenerId ?? (!target.includes(":") ? target : undefined);
            const runnerSocket = getLocalRunnerSocket(runnerId);
            if (runnerSocket) {
                runnerSocket.emit("listener_config_changed" as any, {
                    ...(listenerId ? { listenerId } : {}),
                    triggerType,
                    params: params ?? {},
                    prompt: typeof body.prompt === "string" ? body.prompt : undefined,
                    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
                    model,
                });
            }
            if (listenerId) {
                await emitTriggerSubscriptionDelta(runnerId, {
                    action: "update",
                    subscription: runnerListenerAsSubscription(runnerId, {
                        listenerId,
                        triggerType,
                        params,
                    }),
                }).catch((err) => {
                    log.warn("Failed to emit runner listener update delta:", err);
                });
            }

            return Response.json({ ok: true, ...(listenerId ? { listenerId } : {}), triggerType });
        }

        if (req.method === "DELETE" && listenerMatch[2]) {
            const target = decodeURIComponent(listenerMatch[2]);
            const normalizedListeners = target.includes(":")
                ? (await listRunnerTriggerListeners(runnerId)).filter((listener) => listener.triggerType === target)
                : (() => [])();
            if (!target.includes(":")) {
                const byId = await getRunnerTriggerListener(runnerId, target);
                if (byId) normalizedListeners.push(byId);
            }
            const removed = await removeRunnerTriggerListener(runnerId, target) as any;
            const triggerType = removed?.triggerType ?? target;
            const removedCount = typeof removed?.removed === "number"
                ? removed.removed
                : normalizedListeners.length > 0
                    ? normalizedListeners.length
                    : 0;
            const listenerId = !target.includes(":") ? target : undefined;
            await Promise.all(normalizedListeners.map((listener) => emitTriggerSubscriptionDelta(runnerId, {
                action: "unsubscribe",
                subscription: runnerListenerAsSubscription(runnerId, listener),
            }).catch((err) => {
                log.warn("Failed to emit runner listener unsubscribe delta:", err);
            })));
            return Response.json({ ok: true, ...(listenerId ? { listenerId } : {}), triggerType, removed: removedCount });
        }

        return undefined;
    }

    // ── Skills ─────────────────────────────────────────────────────────
    const skillsMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/skills(?:\/([^/]+))?$/);
    if (skillsMatch) {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(skillsMatch[1]);
        const skillName = skillsMatch[2] ? decodeURIComponent(skillsMatch[2]) : undefined;

        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        // POST /api/runners/:id/skills/refresh — ask runner to re-scan skills from disk
        if (req.method === "POST" && skillName === "refresh") {
            try {
                const result = await sendSkillCommand(runnerId, { type: "list_skills" });
                if (!result.ok) return Response.json({ error: result.message ?? "Skill scan failed" }, { status: 500 });
                return Response.json({ ok: true, skills: result.skills ?? [] });
            } catch (err) {
                skillsLog.error("refresh failed:", err);
                return Response.json({ error: "Failed to refresh skills" }, { status: 502 });
            }
        }

        // GET /api/runners/:id/skills — list skills (from Redis cache)
        if (req.method === "GET" && !skillName) {
            return Response.json({ skills: parseJsonArray(runner.skills) });
        }

        // GET /api/runners/:id/skills/:name — get full skill content
        if (req.method === "GET" && skillName) {
            if (!isValidSkillName(skillName)) return Response.json({ error: "Invalid skill name" }, { status: 400 });
            try {
                const result = await sendSkillCommand(runnerId, { type: "get_skill", name: skillName });
                if (!result.ok) return Response.json({ error: result.message ?? "Skill not found" }, { status: 404 });
                return Response.json({ name: result.name, content: result.content });
            } catch (err) {
                skillsLog.error(`GET ${skillName} failed:`, err);
                return Response.json({ error: "Failed to retrieve skill" }, { status: 502 });
            }
        }

        // POST /api/runners/:id/skills — create a new skill
        if (req.method === "POST" && !skillName) {
            let body: any = {};
            try { body = await req.json(); } catch {}
            const name = typeof body.name === "string" ? body.name.trim() : "";
            const content = typeof body.content === "string" ? body.content : "";

            if (!name) return Response.json({ error: "Missing skill name" }, { status: 400 });
            if (!isValidSkillName(name)) return Response.json({ error: "Invalid skill name" }, { status: 400 });

            try {
                const result = await sendSkillCommand(runnerId, { type: "create_skill", name, content });
                if (!result.ok) return Response.json({ error: result.message ?? "Failed to create skill" }, { status: 400 });
                return Response.json({ ok: true, skills: result.skills ?? [] });
            } catch (err) {
                skillsLog.error(`POST ${name} failed:`, err);
                return Response.json({ error: "Failed to create skill" }, { status: 502 });
            }
        }

        // PUT /api/runners/:id/skills/:name — update a skill
        if (req.method === "PUT" && skillName) {
            if (!isValidSkillName(skillName)) return Response.json({ error: "Invalid skill name" }, { status: 400 });
            let body: any = {};
            try { body = await req.json(); } catch {}
            const content = typeof body.content === "string" ? body.content : "";
            try {
                const result = await sendSkillCommand(runnerId, { type: "update_skill", name: skillName, content });
                if (!result.ok) return Response.json({ error: result.message ?? "Failed to update skill" }, { status: 400 });
                return Response.json({ ok: true, skills: result.skills ?? [] });
            } catch (err) {
                skillsLog.error(`PUT ${skillName} failed:`, err);
                return Response.json({ error: "Failed to update skill" }, { status: 502 });
            }
        }

        // DELETE /api/runners/:id/skills/:name — delete a skill
        if (req.method === "DELETE" && skillName) {
            if (!isValidSkillName(skillName)) return Response.json({ error: "Invalid skill name" }, { status: 400 });
            try {
                const result = await sendSkillCommand(runnerId, { type: "delete_skill", name: skillName });
                if (!result.ok) return Response.json({ error: result.message ?? "Skill not found" }, { status: 404 });
                return Response.json({ ok: true, skills: result.skills ?? [] });
            } catch (err) {
                skillsLog.error(`DELETE ${skillName} failed:`, err);
                return Response.json({ error: "Failed to delete skill" }, { status: 502 });
            }
        }

        return undefined;
    }

    // ── Agents (agent definitions) ───────────────────────────────────
    const agentsMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/agents(?:\/([^/]+))?$/);
    if (agentsMatch) {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(agentsMatch[1]);
        const agentName = agentsMatch[2] ? decodeURIComponent(agentsMatch[2]) : undefined;

        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        // POST /api/runners/:id/agents/refresh — ask runner to re-scan agents from disk
        if (req.method === "POST" && agentName === "refresh") {
            try {
                const result = await sendAgentCommand(runnerId, { type: "list_agents" });
                if (!result.ok) return Response.json({ error: result.message ?? "Agent scan failed" }, { status: 500 });
                return Response.json({ ok: true, agents: result.agents ?? [] });
            } catch (err) {
                agentsLog.error("refresh failed:", err);
                return Response.json({ error: "Failed to refresh agents" }, { status: 502 });
            }
        }

        // GET /api/runners/:id/agents — list agents (from Redis cache)
        if (req.method === "GET" && !agentName) {
            return Response.json({ agents: parseJsonArray(runner.agents) });
        }

        // GET /api/runners/:id/agents/:name — get full agent content
        if (req.method === "GET" && agentName) {
            if (!isValidSkillName(agentName)) return Response.json({ error: "Invalid agent name" }, { status: 400 });
            try {
                const result = await sendAgentCommand(runnerId, { type: "get_agent", name: agentName });
                if (!result.ok) return Response.json({ error: result.message ?? "Agent not found" }, { status: 404 });
                return Response.json({ name: result.name, content: result.content });
            } catch (err) {
                agentsLog.error(`GET ${agentName} failed:`, err);
                return Response.json({ error: "Failed to retrieve agent" }, { status: 502 });
            }
        }

        // POST /api/runners/:id/agents — create a new agent
        if (req.method === "POST" && !agentName) {
            let body: any = {};
            try { body = await req.json(); } catch {}
            const name = typeof body.name === "string" ? body.name.trim() : "";
            const content = typeof body.content === "string" ? body.content : "";

            if (!name) return Response.json({ error: "Missing agent name" }, { status: 400 });
            if (!isValidSkillName(name)) return Response.json({ error: "Invalid agent name" }, { status: 400 });

            try {
                const result = await sendAgentCommand(runnerId, { type: "create_agent", name, content });
                if (!result.ok) return Response.json({ error: result.message ?? "Failed to create agent" }, { status: 400 });
                return Response.json({ ok: true, agents: result.agents ?? [] });
            } catch (err) {
                agentsLog.error(`POST ${name} failed:`, err);
                return Response.json({ error: "Failed to create agent" }, { status: 502 });
            }
        }

        // PUT /api/runners/:id/agents/:name — update an agent
        if (req.method === "PUT" && agentName) {
            if (!isValidSkillName(agentName)) return Response.json({ error: "Invalid agent name" }, { status: 400 });
            let body: any = {};
            try { body = await req.json(); } catch {}
            const content = typeof body.content === "string" ? body.content : "";
            try {
                const result = await sendAgentCommand(runnerId, { type: "update_agent", name: agentName, content });
                if (!result.ok) return Response.json({ error: result.message ?? "Failed to update agent" }, { status: 400 });
                return Response.json({ ok: true, agents: result.agents ?? [] });
            } catch (err) {
                agentsLog.error(`PUT ${agentName} failed:`, err);
                return Response.json({ error: "Failed to update agent" }, { status: 502 });
            }
        }

        // DELETE /api/runners/:id/agents/:name — delete an agent
        if (req.method === "DELETE" && agentName) {
            if (!isValidSkillName(agentName)) return Response.json({ error: "Invalid agent name" }, { status: 400 });
            try {
                const result = await sendAgentCommand(runnerId, { type: "delete_agent", name: agentName });
                if (!result.ok) return Response.json({ error: result.message ?? "Agent not found" }, { status: 404 });
                return Response.json({ ok: true, agents: result.agents ?? [] });
            } catch (err) {
                agentsLog.error(`DELETE ${agentName} failed:`, err);
                return Response.json({ error: "Failed to delete agent" }, { status: 502 });
            }
        }

        return undefined;
    }

    // ── Plugins (Claude Code plugin adapter) ─────────────────────────
    const pluginsMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/plugins$/);
    if (pluginsMatch && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(pluginsMatch[1]);
        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        // If a session cwd is provided, ask the runner daemon to scan from
        // that directory so project-local plugins are correct for the active
        // session (rather than the daemon's own cwd).
        const cwdParam = url.searchParams.get("cwd");
        if (cwdParam) {
            // Validate cwd against runner workspace roots (same check as session spawn)
            // Accept POSIX absolute paths (/...) and Windows drive paths (C:\...)
            const isAbsolute = cwdParam.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwdParam);
            if (!isAbsolute) {
                return Response.json({ error: "cwd must be an absolute path" }, { status: 400 });
            }
            const roots = parseJsonArray(runner.roots);
            if (roots.length > 0 && !cwdMatchesRoots(roots, cwdParam)) {
                return Response.json({ error: "cwd outside allowed workspace roots" }, { status: 403 });
            }
            try {
                const result = await sendRunnerCommand(runnerId, { type: "list_plugins", cwd: cwdParam }) as any;
                if (result?.ok === false) {
                    return Response.json({ error: result.message ?? "Plugin scan rejected" }, { status: 403 });
                }
                return Response.json({ plugins: result?.plugins ?? [] });
            } catch (err) {
                pluginsLog.error("cwd-scoped scan failed:", err);
                return Response.json({ error: "Failed to scan plugins" }, { status: 502 });
            }
        }

        // Return plugins from the Redis cache (populated by daemon on registration)
        return Response.json({ plugins: parseJsonArray(runner.plugins) });
    }

    // POST /api/runners/:id/plugins/refresh — ask runner to re-scan plugins
    const pluginsRefreshMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/plugins\/refresh$/);
    if (pluginsRefreshMatch && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(pluginsRefreshMatch[1]);
        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        try {
            const result = await sendRunnerCommand(runnerId, { type: "list_plugins" }) as any;
            if (result?.ok === false) {
                return Response.json({ error: result.message ?? "Plugin scan rejected" }, { status: 403 });
            }
            return Response.json({ ok: true, plugins: result?.plugins ?? [] });
        } catch (err) {
            pluginsLog.error("refresh failed:", err);
            return Response.json({ error: "Failed to refresh plugins" }, { status: 502 });
        }
    }

    // ── File explorer ──────────────────────────────────────────────────
    const filesMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/files$/);
    if (filesMatch && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(filesMatch[1]);
        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        let body: any = {};
        try { body = await req.json(); } catch { body = {}; }

        const path = typeof body.path === "string" ? body.path : "";
        if (!path) return Response.json({ error: "Missing path" }, { status: 400 });

        const filesRoots = parseJsonArray(runner.roots);
        if (filesRoots.length > 0 && !cwdMatchesRoots(filesRoots, path)) {
            return Response.json({ error: `Runner cannot access path: ${path}` }, { status: 400 });
        }

        try {
            const result = await sendRunnerCommand(runnerId, { type: "list_files", path });
            if (!(result as any).ok) return Response.json({ error: (result as any).message ?? "Failed to list files" }, { status: 500 });
            return Response.json(result);
        } catch (err) {
            return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
        }
    }

    // ── Search files ───────────────────────────────────────────────────
    const searchFilesMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/search-files$/);
    if (searchFilesMatch && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(searchFilesMatch[1]);
        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        let body: any = {};
        try { body = await req.json(); } catch { body = {}; }

        const cwd = typeof body.cwd === "string" ? body.cwd : "";
        const query = typeof body.query === "string" ? body.query : "";
        const limit = typeof body.limit === "number" ? body.limit : 100;

        if (!cwd) return Response.json({ error: "Missing cwd" }, { status: 400 });
        if (!query) return Response.json({ ok: true, files: [] });

        const searchRoots = parseJsonArray(runner.roots);
        if (searchRoots.length > 0 && !cwdMatchesRoots(searchRoots, cwd)) {
            return Response.json({ error: `Runner cannot access cwd: ${cwd}` }, { status: 400 });
        }

        try {
            const result = await sendRunnerCommand(runnerId, { type: "search_files", cwd, query, limit });
            if (!(result as any).ok) return Response.json({ error: (result as any).message ?? "Search failed" }, { status: 500 });
            return Response.json(result);
        } catch (err) {
            return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
        }
    }

    // ── Read file ──────────────────────────────────────────────────────
    const readFileMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/read-file$/);
    if (readFileMatch && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(readFileMatch[1]);
        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        let body: any = {};
        try { body = await req.json(); } catch { body = {}; }

        const path = typeof body.path === "string" ? body.path : "";
        if (!path) return Response.json({ error: "Missing path" }, { status: 400 });

        const readFileRoots = parseJsonArray(runner.roots);
        if (readFileRoots.length > 0 && !cwdMatchesRoots(readFileRoots, path)) {
            return Response.json({ error: `Runner cannot access path: ${path}` }, { status: 400 });
        }

        const encoding = body.encoding === "base64" ? "base64" : "utf8";
        const maxBytes = encoding === "base64" ? 10 * 1024 * 1024 : 512 * 1024;
        const timeout = encoding === "base64" ? 30_000 : 15_000;

        try {
            const result = await sendRunnerCommand(runnerId, { type: "read_file", path, encoding, maxBytes }, timeout);
            if (!(result as any).ok) return Response.json({ error: (result as any).message ?? "Failed to read file" }, { status: 500 });
            return Response.json(result);
        } catch (err) {
            return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
        }
    }

    // ── Git ───────────────────────────────────────────────────────────
    // Git operations (status, diff, branches, checkout, stage, unstage,
    // commit, push) are handled entirely through the service_message
    // channel. The viewer sends service_message envelopes with
    // serviceId="git" which are relayed to the runner's GitService.
    // No REST routes needed — see git-service.ts on the runner side.

    // ── Sandbox ───────────────────────────────────────────────────────

    // GET /api/runners/:id/sandbox-status
    const sandboxStatusMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/sandbox-status$/);
    if (sandboxStatusMatch && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(sandboxStatusMatch[1]);
        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        try {
            const result = await sendRunnerCommand(runnerId, { type: "sandbox_get_status" }) as any;
            if (result && result.ok === false) {
                return Response.json({ error: result.message ?? "Sandbox status command failed" }, { status: 502 });
            }
            return Response.json(result);
        } catch (err) {
            return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
        }
    }

    // PUT /api/runners/:id/sandbox-config
    const sandboxConfigMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/sandbox-config$/);
    if (sandboxConfigMatch && req.method === "PUT") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(sandboxConfigMatch[1]);
        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        let body: any;
        try {
            body = await req.json();
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        // Validate
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
        }
        const validModes = ["none", "basic", "full"];
        if (body.mode !== undefined && !validModes.includes(body.mode)) {
            return Response.json({ error: `Invalid mode "${body.mode}"` }, { status: 400 });
        }
        // Validate array fields contain only strings
        const arrayFields = [
            body.filesystem?.denyRead,
            body.filesystem?.allowWrite,
            body.filesystem?.denyWrite,
            body.network?.allowedDomains,
            body.network?.deniedDomains,
        ].filter(Boolean);
        for (const arr of arrayFields) {
            if (!Array.isArray(arr) || !arr.every((v: any) => typeof v === "string")) {
                return Response.json({ error: "Array fields must contain only strings" }, { status: 400 });
            }
        }

        try {
            const result = await sendRunnerCommand(runnerId, { type: "sandbox_update_config", config: body }) as any;
            if (result && result.ok === false) {
                return Response.json({ error: result.message ?? "Sandbox config update failed" }, { status: 502 });
            }
            return Response.json(result);
        } catch (err) {
            return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
        }
    }

    // GET /api/runners/:id/usage
    const usageMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/usage$/);
    if (usageMatch && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(usageMatch[1]);
        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        const range = url.searchParams.get("range") || "90d";
        const validRanges = ["7d", "30d", "90d", "all"];
        if (!validRanges.includes(range)) {
            return Response.json({ error: "Invalid range parameter" }, { status: 400 });
        }

        try {
            const result = await sendRunnerCommand(runnerId, { type: "get_usage", range }, 30_000) as any;
            if (result && result.error) {
                return Response.json({ error: result.error }, { status: 502 });
            }
            return Response.json(result);
        } catch (err) {
            return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
        }
    }

    return undefined;
};
