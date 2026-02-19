import { getModel, getProviders, getModels } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createToolkit } from "@pizzapi/tools";

const PORT = parseInt(process.env.PORT ?? "3000");

const server = Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/health") {
            return Response.json({ status: "ok" });
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

                // Collect assistant text from events
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
});

console.log(`PizzaPi server running on http://localhost:${server.port}`);
