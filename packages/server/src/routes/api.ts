import { getModel, getProviders, getModels } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createToolkit } from "@pizzapi/tools";
import { getRunners, getSessions, getSharedSession } from "../ws/registry.js";
import { apiKeyRateLimitConfig, auth, kysely } from "../auth.js";
import { requireSession, validateApiKey } from "../middleware.js";
import { listPersistedRelaySessionsForUser } from "../sessions/store.js";
import {
    attachmentMaxFileSizeBytes,
    getStoredAttachment,
    storeSessionAttachment,
} from "../attachments/store.js";

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
        return Response.json({ runners: getRunners() });
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

    return undefined;
}
