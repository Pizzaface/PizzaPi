/**
 * Runners router — runner management, session spawn, skills, files, git.
 *
 * This is the largest router. If it exceeds 500 lines, split into sub-modules
 * (runners-core.ts, runners-skills.ts, runners-files.ts, runners-git.ts).
 */

import {
    getRunnerData,
    getRunners,
    getLocalRunnerSocket,
    linkSessionToRunner,
    recordRunnerSession,
    registerTerminal,
} from "../ws/sio-registry.js";
import { sendSkillCommand, sendAgentCommand, sendRunnerCommand } from "../ws/namespaces/runner.js";
import { waitForSpawnAck } from "../ws/runner-control.js";
import { requireSession, validateApiKey } from "../middleware.js";
import { getRecentFolders, recordRecentFolder } from "../runner-recent-folders.js";
import { getHiddenModels } from "../user-hidden-models.js";
import { cwdMatchesRoots } from "../security.js";
import { isValidSkillName } from "../validation.js";
import { parseJsonArray } from "./utils.js";
import type { RouteHandler } from "./types.js";

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
        const requestedModel =
            body.model && typeof body.model === "object" &&
            typeof (body.model as any).provider === "string" &&
            typeof (body.model as any).id === "string"
                ? { provider: (body.model as any).provider as string, id: (body.model as any).id as string }
                : undefined;

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

        const runnerSocket = getLocalRunnerSocket(runnerId);
        if (!runnerSocket) {
            return Response.json({ error: "Runner is not connected to this server" }, { status: 502 });
        }

        const sessionId = crypto.randomUUID();

        let hiddenModels: string[] = [];
        try { hiddenModels = await getHiddenModels(identity.userId); } catch {}

        try {
            runnerSocket.emit("new_session", {
                sessionId,
                cwd: requestedCwd,
                ...(requestedPrompt ? { prompt: requestedPrompt } : {}),
                ...(requestedModel ? { model: requestedModel } : {}),
                ...(hiddenModels.length > 0 ? { hiddenModels } : {}),
                ...(requestedAgent ? { agent: requestedAgent } : {}),
            });
        } catch {
            return Response.json({ error: "Failed to send spawn request to runner" }, { status: 502 });
        }

        const ack = await waitForSpawnAck(sessionId, 5_000);
        if (ack.ok === false && !(ack as any).timeout) {
            return Response.json({ error: ack.message }, { status: 400 });
        }

        await recordRunnerSession(runnerId, sessionId);
        await linkSessionToRunner(runnerId, sessionId);

        if (requestedCwd) {
            void recordRecentFolder(identity.userId, runnerId, requestedCwd).catch(() => {});
        }

        return Response.json({ ok: true, runnerId, sessionId, pending: (ack as any).timeout === true });
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
                console.error(`[skills] refresh failed:`, err);
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
                console.error(`[skills] GET ${skillName} failed:`, err);
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
                console.error(`[skills] POST ${name} failed:`, err);
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
                console.error(`[skills] PUT ${skillName} failed:`, err);
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
                console.error(`[skills] DELETE ${skillName} failed:`, err);
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
                console.error(`[agents] refresh failed:`, err);
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
                console.error(`[agents] GET ${agentName} failed:`, err);
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
                console.error(`[agents] POST ${name} failed:`, err);
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
                console.error(`[agents] PUT ${agentName} failed:`, err);
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
                console.error(`[agents] DELETE ${agentName} failed:`, err);
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
                console.error(`[plugins] cwd-scoped scan failed:`, err);
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
            console.error(`[plugins] refresh failed:`, err);
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

    // ── Git status ─────────────────────────────────────────────────────
    const gitStatusMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/git-status$/);
    if (gitStatusMatch && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(gitStatusMatch[1]);
        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        let body: any = {};
        try { body = await req.json(); } catch { body = {}; }

        const cwd = typeof body.cwd === "string" ? body.cwd : "";
        if (!cwd) return Response.json({ error: "Missing cwd" }, { status: 400 });

        try {
            const result = await sendRunnerCommand(runnerId, { type: "git_status", cwd });
            if (!(result as any).ok) return Response.json({ error: (result as any).message ?? "Failed to get git status" }, { status: 500 });
            return Response.json(result);
        } catch (err) {
            return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
        }
    }

    // ── Git diff ───────────────────────────────────────────────────────
    const gitDiffMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/git-diff$/);
    if (gitDiffMatch && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(gitDiffMatch[1]);
        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        let body: any = {};
        try { body = await req.json(); } catch { body = {}; }

        const cwd = typeof body.cwd === "string" ? body.cwd : "";
        const path = typeof body.path === "string" ? body.path : "";
        const staged = body.staged === true;
        if (!cwd || !path) return Response.json({ error: "Missing cwd or path" }, { status: 400 });

        try {
            const result = await sendRunnerCommand(runnerId, { type: "git_diff", cwd, path, staged });
            if (!(result as any).ok) return Response.json({ error: (result as any).message ?? "Failed to get diff" }, { status: 500 });
            return Response.json(result);
        } catch (err) {
            return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
        }
    }

    return undefined;
};
