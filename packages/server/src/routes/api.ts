import { getModel, getProviders, getModels } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createToolkit } from "@pizzapi/tools";
import { getRunners, getSessions } from "../ws/registry.js";
import { auth, kysely } from "../auth.js";
import { requireSession } from "../middleware.js";

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
                key,
                userId,
                refillInterval: null,
                refillAmount: null,
                lastRefillAt: null,
                enabled: 1,
                rateLimitEnabled: 0,
                rateLimitTimeWindow: null,
                rateLimitMax: null,
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
        return Response.json({ sessions: getSessions(identity.userId) });
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
