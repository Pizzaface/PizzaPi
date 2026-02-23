import { getModel, getProviders, getModels } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createToolkit } from "@pizzapi/tools";
import { getRunner, getRunners, getSessions, getSharedSession, linkSessionToRunner, recordRunnerSession, registerTerminal } from "../ws/registry.js";
import { sendSkillCommand } from "../ws/relay.js";
import { waitForSpawnAck } from "../ws/runner-control.js";
import { apiKeyRateLimitConfig, auth, kysely } from "../auth.js";
import { requireSession, validateApiKey } from "../middleware.js";
import { listPersistedRelaySessionsForUser } from "../sessions/store.js";
import { getRecentFolders, recordRecentFolder } from "../runner-recent-folders.js";
import {
    attachmentMaxFileSizeBytes,
    getStoredAttachment,
    storeSessionAttachment,
} from "../attachments/store.js";
import {
    getVapidPublicKey,
    subscribePush,
    unsubscribePush,
    getSubscriptionsForUser,
    updateEnabledEvents,
} from "../push.js";

export async function handleApi(req: Request, url: URL): Promise<Response | undefined> {
    if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
    }

    if (url.pathname === "/api/register" && req.method === "POST") {
        const body = await req.json() as { name?: string; email?: string; password?: string };
        const { name, email, password } = body;
        if (!email || !password) {
            return Response.json({ error: "Missing required fields: email, password" }, { status: 400 });
        }

        const existing = await kysely
            .selectFrom("user")
            .select("id")
            .where("email", "=", email)
            .executeTakeFirst();

        let userId: string;
        if (existing) {
            // Verify password by attempting sign-in
            const signIn = await auth.api.signInEmail({
                body: { email, password },
            }).catch(() => null);
            if (!signIn?.user?.id) {
                return Response.json({ error: "Invalid credentials" }, { status: 401 });
            }
            userId = signIn.user.id;
        } else {
            if (!name) {
                return Response.json({ error: "Missing required field: name (required for new accounts)" }, { status: 400 });
            }
            const created = await auth.api.signUpEmail({
                body: { name, email, password },
            });
            if (!created?.user?.id) {
                return Response.json({ error: "Failed to create user" }, { status: 500 });
            }
            userId = created.user.id;
        }

        // Generate a fresh API key for CLI use
        const { randomBytes } = await import("crypto");
        const key = randomBytes(32).toString("hex");

        // Hash key using SHA-256 + base64url (matches better-auth's defaultKeyHasher)
        const keyHashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
        const hashedKey = btoa(String.fromCharCode(...new Uint8Array(keyHashBuf)))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=/g, "");

        await kysely
            .deleteFrom("apikey")
            .where("userId", "=", userId)
            .where("name", "=", "cli")
            .execute();

        const now = new Date().toISOString();
        await kysely
            .insertInto("apikey")
            .values({
                id: crypto.randomUUID(),
                name: "cli",
                start: key.slice(0, 8),
                prefix: null,
                key: hashedKey,
                userId,
                refillInterval: null,
                refillAmount: null,
                lastRefillAt: null,
                enabled: 1,
                rateLimitEnabled: apiKeyRateLimitConfig.enabled ? 1 : 0,
                rateLimitTimeWindow: apiKeyRateLimitConfig.enabled ? apiKeyRateLimitConfig.timeWindow : null,
                rateLimitMax: apiKeyRateLimitConfig.enabled ? apiKeyRateLimitConfig.maxRequests : null,
                requestCount: 0,
                remaining: null,
                lastRequest: null,
                expiresAt: null,
                createdAt: now,
                updatedAt: now,
                permissions: null,
                metadata: null,
            })
            .execute();

        return Response.json({ ok: true, key });
    }

    if (url.pathname === "/api/runners" && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;
        return Response.json({ runners: getRunners(identity.userId) });
    }

    if (url.pathname === "/api/runners/spawn" && req.method === "POST") {
        const providedApiKey = req.headers.get("x-api-key") ?? undefined;
        const identity = providedApiKey
            ? await validateApiKey(req, providedApiKey)
            : await requireSession(req);
        if (identity instanceof Response) return identity;

        let body: any = {};
        try {
            body = await req.json();
        } catch {
            body = {};
        }

        const requestedRunnerId = typeof body.runnerId === "string" ? body.runnerId : undefined;
        const requestedCwd = typeof body.cwd === "string" ? body.cwd : undefined;
        const requestedPrompt = typeof body.prompt === "string" ? body.prompt : undefined;
        const requestedModel =
            body.model && typeof body.model === "object" &&
            typeof (body.model as any).provider === "string" &&
            typeof (body.model as any).id === "string"
                ? { provider: (body.model as any).provider as string, id: (body.model as any).id as string }
                : undefined;

        // Sessions are tied to a folder on a specific runner machine.
        // We do not attempt to infer which runner has which path — the client must choose.
        if (!requestedRunnerId) {
            return Response.json({ error: "Missing runnerId" }, { status: 400 });
        }

        const runnerId = requestedRunnerId;
        const runner = getRunner(runnerId);
        if (!runner) {
            return Response.json({ error: "Runner not found" }, { status: 404 });
        }
        const runnerUserId = (runner as any).userId as string | null | undefined;
        if (!runnerUserId) {
            return Response.json({ error: "Runner is not associated with a user" }, { status: 403 });
        }
        if (runnerUserId !== identity.userId) {
            return Response.json({ error: "Forbidden" }, { status: 403 });
        }

        if (requestedCwd) {
            // Safety check: server-side enforcement (runner also enforces).
            // If the runner declares workspace roots, do not allow spawning outside them.
            const hasRoots = Array.isArray((runner as any).roots) && (runner as any).roots.length > 0;
            if (hasRoots && !runnerHasCwdAccess(runner, requestedCwd)) {
                return Response.json({ error: `Runner cannot access cwd: ${requestedCwd}` }, { status: 400 });
            }
        }

        const sessionId = crypto.randomUUID();

        try {
            runner.ws.send(
                JSON.stringify({
                    type: "new_session",
                    sessionId,
                    cwd: requestedCwd,
                    ...(requestedPrompt ? { prompt: requestedPrompt } : {}),
                    ...(requestedModel ? { model: requestedModel } : {}),
                }),
            );
        } catch {
            return Response.json({ error: "Failed to send spawn request to runner" }, { status: 502 });
        }

        // Wait briefly for the runner to accept/reject (e.g. cwd missing/outside roots).
        const ack = await waitForSpawnAck(sessionId, 5_000);
        if (ack.ok === false && !(ack as any).timeout) {
            return Response.json({ error: ack.message }, { status: 400 });
        }

        // Best-effort accounting
        recordRunnerSession(runnerId, sessionId);
        linkSessionToRunner(runnerId, sessionId);

        // Persist this cwd as a recent folder for the runner (best-effort, fire-and-forget).
        if (requestedCwd) {
            void recordRecentFolder(identity.userId, runnerId, requestedCwd).catch(() => {});
        }

        return Response.json({ ok: true, runnerId, sessionId, pending: (ack as any).timeout === true });
    }

    if (url.pathname === "/api/runners/restart" && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        let body: any = {};
        try {
            body = await req.json();
        } catch {
            body = {};
        }

        const runnerId = typeof body.runnerId === "string" ? body.runnerId : undefined;
        if (!runnerId) {
            return Response.json({ error: "Missing runnerId" }, { status: 400 });
        }

        const runner = getRunner(runnerId);
        if (!runner) {
            return Response.json({ error: "Runner not found" }, { status: 404 });
        }

        const runnerUserId = (runner as any).userId as string | null | undefined;
        if (runnerUserId !== identity.userId) {
            return Response.json({ error: "Forbidden" }, { status: 403 });
        }

        try {
            runner.ws.send(JSON.stringify({ type: "restart" }));
        } catch {
            return Response.json({ error: "Failed to send restart request to runner" }, { status: 502 });
        }

        return Response.json({ ok: true });
    }

    // ── Terminal creation ────────────────────────────────────────────────────

    if (url.pathname === "/api/runners/terminal" && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        let body: any = {};
        try { body = await req.json(); } catch { body = {}; }

        const runnerId = typeof body.runnerId === "string" ? body.runnerId : undefined;
        const requestedCwd = typeof body.cwd === "string" ? body.cwd : undefined;
        const cols = typeof body.cols === "number" ? body.cols : 80;
        const rows = typeof body.rows === "number" ? body.rows : 24;

        if (!runnerId) {
            return Response.json({ error: "Missing runnerId" }, { status: 400 });
        }

        const runner = getRunner(runnerId);
        if (!runner) {
            return Response.json({ error: "Runner not found" }, { status: 404 });
        }

        const runnerUserId = (runner as any).userId as string | null | undefined;
        if (!runnerUserId || runnerUserId !== identity.userId) {
            return Response.json({ error: "Forbidden" }, { status: 403 });
        }

        const terminalId = crypto.randomUUID();

        // Register the terminal in "pending" state. The PTY is NOT spawned yet —
        // it will be triggered when the viewer's WebSocket connects and sends its
        // first terminal_resize with real dimensions. This eliminates the race
        // where the PTY starts (and possibly exits) before the viewer is ready.
        registerTerminal(terminalId, runnerId, identity.userId, {
            cwd: requestedCwd,
            cols,
            rows,
        });

        return Response.json({ ok: true, terminalId, runnerId });
    }

    // ── Runner recent folders ─────────────────────────────────────────────────

    const recentFoldersMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/recent-folders$/);
    if (recentFoldersMatch) {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(recentFoldersMatch[1]);
        const runner = getRunner(runnerId);
        if (!runner) {
            return Response.json({ error: "Runner not found" }, { status: 404 });
        }
        const runnerUserId = (runner as any).userId as string | null | undefined;
        if (runnerUserId !== identity.userId) {
            return Response.json({ error: "Forbidden" }, { status: 403 });
        }

        if (req.method === "GET") {
            const folders = await getRecentFolders(identity.userId, runnerId);
            return Response.json({ folders });
        }

        return undefined;
    }

    // ── Runner skills ─────────────────────────────────────────────────────────

    const skillsMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/skills(?:\/([^/]+))?$/);
    if (skillsMatch) {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(skillsMatch[1]);
        const skillName = skillsMatch[2] ? decodeURIComponent(skillsMatch[2]) : undefined;

        const runner = getRunner(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });

        const runnerUserId = (runner as any).userId as string | null | undefined;
        if (runnerUserId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        // GET /api/runners/:id/skills — list skills (from in-memory cache)
        if (req.method === "GET" && !skillName) {
            return Response.json({ skills: (runner as any).skills ?? [] });
        }

        // GET /api/runners/:id/skills/:name — get full skill content
        if (req.method === "GET" && skillName) {
            try {
                const result = await sendSkillCommand(runnerId, { type: "get_skill", name: skillName });
                if (!result.ok) return Response.json({ error: result.message ?? "Skill not found" }, { status: 404 });
                return Response.json({ name: result.name, content: result.content });
            } catch (err) {
                return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
            }
        }

        // POST /api/runners/:id/skills — create a new skill
        if (req.method === "POST" && !skillName) {
            let body: any = {};
            try { body = await req.json(); } catch {}
            const name = typeof body.name === "string" ? body.name.trim() : "";
            const content = typeof body.content === "string" ? body.content : "";
            if (!name) return Response.json({ error: "Missing skill name" }, { status: 400 });
            try {
                const result = await sendSkillCommand(runnerId, { type: "create_skill", name, content });
                if (!result.ok) return Response.json({ error: result.message ?? "Failed to create skill" }, { status: 400 });
                return Response.json({ ok: true, skills: result.skills ?? [] });
            } catch (err) {
                return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
            }
        }

        // PUT /api/runners/:id/skills/:name — update a skill
        if (req.method === "PUT" && skillName) {
            let body: any = {};
            try { body = await req.json(); } catch {}
            const content = typeof body.content === "string" ? body.content : "";
            try {
                const result = await sendSkillCommand(runnerId, { type: "update_skill", name: skillName, content });
                if (!result.ok) return Response.json({ error: result.message ?? "Failed to update skill" }, { status: 400 });
                return Response.json({ ok: true, skills: result.skills ?? [] });
            } catch (err) {
                return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
            }
        }

        // DELETE /api/runners/:id/skills/:name — delete a skill
        if (req.method === "DELETE" && skillName) {
            try {
                const result = await sendSkillCommand(runnerId, { type: "delete_skill", name: skillName });
                if (!result.ok) return Response.json({ error: result.message ?? "Skill not found" }, { status: 404 });
                return Response.json({ ok: true, skills: result.skills ?? [] });
            } catch (err) {
                return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
            }
        }

        return undefined;
    }

    if (url.pathname === "/api/sessions" && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;
        const sessions = getSessions(identity.userId);
        const persistedSessions = await listPersistedRelaySessionsForUser(identity.userId);
        return Response.json({ sessions, persistedSessions });
    }

    if (url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/attachments") && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(
            url.pathname.slice("/api/sessions/".length, -"/attachments".length),
        );

        if (!sessionId) {
            return Response.json({ error: "Missing session ID" }, { status: 400 });
        }

        const session = getSharedSession(sessionId);
        if (!session) {
            return Response.json({ error: "Session is not live" }, { status: 404 });
        }

        const formData = await req.formData();
        const maxBytes = attachmentMaxFileSizeBytes();

        const fileValues = [
            ...formData.getAll("files"),
            ...formData.getAll("file"),
        ];

        const files = fileValues.filter((value): value is File => value instanceof File);

        if (files.length === 0) {
            return Response.json({ error: "No files uploaded" }, { status: 400 });
        }

        for (const file of files) {
            if (file.size > maxBytes) {
                return Response.json(
                    { error: `File too large: ${file.name} exceeds ${maxBytes} bytes` },
                    { status: 413 },
                );
            }
        }

        const ownerUserId = session.userId ?? identity.userId;

        const attachments = await Promise.all(
            files.map((file) =>
                storeSessionAttachment({
                    sessionId,
                    ownerUserId,
                    uploaderUserId: identity.userId,
                    file,
                }),
            ),
        );

        return Response.json({
            attachments: attachments.map((attachment) => ({
                attachmentId: attachment.attachmentId,
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                size: attachment.size,
                expiresAt: attachment.expiresAt,
            })),
        });
    }

    if (url.pathname.startsWith("/api/attachments/") && req.method === "GET") {
        const attachmentId = decodeURIComponent(url.pathname.slice("/api/attachments/".length));
        if (!attachmentId) {
            return Response.json({ error: "Missing attachment ID" }, { status: 400 });
        }

        const providedApiKey = req.headers.get("x-api-key") ?? url.searchParams.get("apiKey") ?? undefined;
        const identity = providedApiKey
            ? await validateApiKey(req, providedApiKey)
            : await requireSession(req);
        if (identity instanceof Response) return identity;

        const attachment = getStoredAttachment(attachmentId);
        if (!attachment) {
            return Response.json({ error: "Attachment not found" }, { status: 404 });
        }

        if (attachment.ownerUserId !== identity.userId) {
            return Response.json({ error: "Forbidden" }, { status: 403 });
        }

        return new Response(Bun.file(attachment.filePath), {
            headers: {
                "content-type": attachment.mimeType,
                "content-length": String(attachment.size),
                "content-disposition": `inline; filename="${attachment.filename.replace(/\"/g, "")}"`,
                "x-attachment-id": attachment.attachmentId,
                "x-attachment-filename": attachment.filename,
            },
        });
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;
        const body = await req.json();
        const { message, provider, model: modelId } = body;

        if (!message || !provider || !modelId) {
            return Response.json(
                { error: "Missing required fields: message, provider, model" },
                { status: 400 },
            );
        }

        try {
            const model = getModel(provider, modelId);
            const tools = createToolkit();

            const agent = new Agent({
                initialState: {
                    systemPrompt: "You are PizzaPi, a helpful AI assistant with tool access.",
                    model,
                    tools,
                },
                getApiKey: async (p) => {
                    const envKey = `${p.toUpperCase().replace(/-/g, "_")}_API_KEY`;
                    return process.env[envKey];
                },
            });

            let responseText = "";
            agent.subscribe((event: AgentEvent) => {
                if (
                    event.type === "message_update" &&
                    event.assistantMessageEvent.type === "text_delta"
                ) {
                    responseText += event.assistantMessageEvent.delta;
                }
            });

            await agent.prompt(message);
            await agent.waitForIdle();

            return Response.json({ response: responseText });
        } catch (error) {
            return Response.json(
                { error: error instanceof Error ? error.message : String(error) },
                { status: 500 },
            );
        }
    }

    if (url.pathname === "/api/models" && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;
        const providers = getProviders();
        const models = providers.flatMap((p) =>
            getModels(p).map((m) => ({ provider: p, id: m.id, name: m.name })),
        );
        return Response.json({ models });
    }

    // ── Push notification endpoints ────────────────────────────────────────────

    if (url.pathname === "/api/push/vapid-public-key" && req.method === "GET") {
        return Response.json({ publicKey: getVapidPublicKey() });
    }

    if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const body = await req.json() as {
            endpoint?: string;
            keys?: { p256dh?: string; auth?: string };
            enabledEvents?: string;
        };

        if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
            return Response.json(
                { error: "Missing required fields: endpoint, keys.p256dh, keys.auth" },
                { status: 400 },
            );
        }

        const id = await subscribePush({
            userId: identity.userId,
            endpoint: body.endpoint,
            keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
            enabledEvents: body.enabledEvents,
        });

        return Response.json({ ok: true, id });
    }

    if (url.pathname === "/api/push/unsubscribe" && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const body = await req.json() as { endpoint?: string };
        if (!body.endpoint) {
            return Response.json({ error: "Missing endpoint" }, { status: 400 });
        }

        await unsubscribePush(identity.userId, body.endpoint);
        return Response.json({ ok: true });
    }

    if (url.pathname === "/api/push/subscriptions" && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const subs = await getSubscriptionsForUser(identity.userId);
        return Response.json({
            subscriptions: subs.map((s) => ({
                id: s.id,
                endpoint: s.endpoint,
                createdAt: s.createdAt,
                enabledEvents: s.enabledEvents,
            })),
        });
    }

    if (url.pathname === "/api/push/events" && req.method === "PUT") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const body = await req.json() as { endpoint?: string; enabledEvents?: string };
        if (!body.endpoint || !body.enabledEvents) {
            return Response.json({ error: "Missing endpoint or enabledEvents" }, { status: 400 });
        }

        await updateEnabledEvents(identity.userId, body.endpoint, body.enabledEvents);
        return Response.json({ ok: true });
    }

    return undefined;
}

function normalizePath(value: string): string {
    const trimmed = value.trim().replace(/\\/g, "/");
    return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

function runnerHasCwdAccess(runner: ReturnType<typeof getRunner>, cwd: string): boolean {
    if (!runner) return false;
    const roots = (runner as any).roots as string[] | undefined;
    if (!roots || roots.length === 0) return false;
    const nCwd = normalizePath(cwd);
    return roots.some((root) => {
        const r = normalizePath(root);
        return nCwd === r || nCwd.startsWith(r + "/");
    });
}

function pickRunnerIdLeastLoaded(): string | null {
    const runners = getRunners().slice().sort((a, b) => a.sessionCount - b.sessionCount);
    return runners.length > 0 ? runners[0].runnerId : null;
}

function pickRunnerIdForCwd(requestedCwd?: string): string | null {
    const cwd = requestedCwd?.trim() ? requestedCwd : undefined;
    if (!cwd) return null;

    const all = getRunners().map((r) => ({
        runnerId: r.runnerId,
        sessionCount: r.sessionCount,
        roots: (r as any).roots as string[] | undefined,
    }));

    const nCwd = normalizePath(cwd);

    // 1) Prefer runners that declare roots AND match the cwd.
    const rootMatched = all
        .filter((r) => Array.isArray(r.roots) && r.roots.length > 0)
        .filter((r) => (r.roots ?? []).some((root) => {
            const nRoot = normalizePath(root);
            return nCwd === nRoot || nCwd.startsWith(nRoot + "/");
        }))
        .sort((a, b) => a.sessionCount - b.sessionCount);

    if (rootMatched.length > 0) return rootMatched[0].runnerId;

    // 2) Fallback: ONLY if no runner declared any roots.
    // In that case we have no reliable way to match a cwd to a runner, so we pick
    // least-loaded and let the runner accept/reject based on actual filesystem.
    const anyRootsDeclared = all.some((r) => Array.isArray(r.roots) && r.roots.length > 0);
    if (anyRootsDeclared) return null;

    const fallback = all.slice().sort((a, b) => a.sessionCount - b.sessionCount);
    return fallback.length > 0 ? fallback[0].runnerId : null;
}

async function mintEphemeralApiKey(userId: string, name: string, ttlSeconds: number): Promise<string> {
    const { randomBytes } = await import("crypto");
    const key = randomBytes(32).toString("hex");

    // Hash key using SHA-256 + base64url (matches better-auth's defaultKeyHasher)
    const keyHashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const hashedKey = btoa(String.fromCharCode(...new Uint8Array(keyHashBuf)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");

    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    await kysely
        .insertInto("apikey")
        .values({
            id: crypto.randomUUID(),
            name,
            start: key.slice(0, 8),
            prefix: null,
            key: hashedKey,
            userId,
            refillInterval: null,
            refillAmount: null,
            lastRefillAt: null,
            enabled: 1,
            rateLimitEnabled: apiKeyRateLimitConfig.enabled ? 1 : 0,
            rateLimitTimeWindow: apiKeyRateLimitConfig.enabled ? apiKeyRateLimitConfig.timeWindow : null,
            rateLimitMax: apiKeyRateLimitConfig.enabled ? apiKeyRateLimitConfig.maxRequests : null,
            requestCount: 0,
            remaining: null,
            lastRequest: null,
            expiresAt,
            createdAt: nowIso,
            updatedAt: nowIso,
            permissions: null,
            metadata: null,
        })
        .execute();

    return key;
}
