import { getModel, getProviders, getModels } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createToolkit } from "@pizzapi/tools";
import type { WsData } from "./ws/registry.js";
import { getRunners, getSessions } from "./ws/registry.js";
import { onClose, onMessage, onOpen } from "./ws/relay.js";

const PORT = parseInt(process.env.PORT ?? "3000");

const server = Bun.serve<WsData>({
    port: PORT,

    async fetch(req, server) {
        const url = new URL(req.url);

        // ── WebSocket upgrade ──────────────────────────────────────────────────
        if (url.pathname === "/ws/sessions") {
            // TUI connecting to register a live-share session
            const upgraded = server.upgrade(req, { data: { role: "tui" } });
            if (upgraded) return;
            return new Response("WebSocket upgrade failed", { status: 400 });
        }

        if (url.pathname.startsWith("/ws/sessions/")) {
            // Browser viewer connecting to watch a session
            const sessionId = url.pathname.slice("/ws/sessions/".length);
            if (!sessionId) return new Response("Missing session ID", { status: 400 });
            const upgraded = server.upgrade(req, { data: { role: "viewer", sessionId } });
            if (upgraded) return;
            return new Response("WebSocket upgrade failed", { status: 400 });
        }

        if (url.pathname === "/ws/runner") {
            // Runner daemon connecting (Task 003) — token passed as ?token=... query param
            const token = url.searchParams.get("token") ?? "";
            const expected = process.env.PIZZAPI_RUNNER_TOKEN;
            if (!expected || token !== expected) {
                return new Response("Unauthorized", { status: 401 });
            }
            const upgraded = server.upgrade(req, { data: { role: "runner" } });
            if (upgraded) return;
            return new Response("WebSocket upgrade failed", { status: 400 });
        }

        if (url.pathname === "/ws/hub") {
            // Web UI connecting to watch the live session list
            const upgraded = server.upgrade(req, { data: { role: "hub" } });
            if (upgraded) return;
            return new Response("WebSocket upgrade failed", { status: 400 });
        }

        // ── REST endpoints ─────────────────────────────────────────────────────
        if (url.pathname === "/health") {
            return Response.json({ status: "ok" });
        }

        if (url.pathname === "/api/runners" && req.method === "GET") {
            return Response.json({ runners: getRunners() });
        }

        if (url.pathname === "/api/sessions" && req.method === "GET") {
            return Response.json({ sessions: getSessions() });
        }

        if (url.pathname === "/api/chat" && req.method === "POST") {
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
            const providers = getProviders();
            const models = providers.flatMap((p) =>
                getModels(p).map((m) => ({ provider: p, id: m.id, name: m.name })),
            );
            return Response.json({ models });
        }

        return Response.json({ error: "Not found" }, { status: 404 });
    },

    websocket: {
        open: onOpen,
        message: onMessage,
        close: onClose,
    },
});

console.log(`PizzaPi server running on http://localhost:${server.port}`);
