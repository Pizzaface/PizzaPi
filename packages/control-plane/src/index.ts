import { auth } from "./auth.js";

const PORT = parseInt(process.env.PORT ?? "3100");

const server = Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);

        // ── Health check ───────────────────────────────────────────────────
        if (url.pathname === "/health" && req.method === "GET") {
            return Response.json({ status: "ok" });
        }

        // ── better-auth handler ────────────────────────────────────────────
        if (url.pathname.startsWith("/api/auth")) {
            try {
                return await auth.handler(req);
            } catch (e) {
                console.error("[auth] handler threw:", e);
                return Response.json({ error: "Auth error" }, { status: 500 });
            }
        }

        return Response.json({ error: "Not found" }, { status: 404 });
    },
});

console.log(`Control-plane server running on http://localhost:${server.port}`);
