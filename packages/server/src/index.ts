import { createProvider } from "@pizzapi/providers";
import { Agent } from "@pizzapi/runtime";
import { bashTool, readFileTool, writeFileTool, searchTool } from "@pizzapi/tools";

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
            const { message, provider: providerType, model, apiKey } = body;

            if (!message || !providerType || !model || !apiKey) {
                return Response.json({ error: "Missing required fields" }, { status: 400 });
            }

            const provider = createProvider(providerType, { apiKey });
            const agent = new Agent({
                provider,
                model,
                tools: [bashTool, readFileTool, writeFileTool, searchTool],
            });

            const response = await agent.run(message);
            return Response.json({ response });
        }

        return Response.json({ error: "Not found" }, { status: 404 });
    },
});

console.log(`PizzaPi server running on http://localhost:${server.port}`);
