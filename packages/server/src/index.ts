import type { WsData } from "./ws/registry.js";
import { onClose, onMessage, onOpen } from "./ws/relay.js";
import { auth } from "./auth.js";
import { handleWsUpgrade } from "./routes/ws.js";
import { handleApi } from "./routes/api.js";

const PORT = parseInt(process.env.PORT ?? "3000");

const server = Bun.serve<WsData>({
    port: PORT,

    async fetch(req, server) {
        const url = new URL(req.url);

        // ── better-auth handler ────────────────────────────────────────────────
        if (url.pathname.startsWith("/api/auth")) {
            return auth.handler(req);
        }

        // ── WebSocket upgrades ─────────────────────────────────────────────────
        if (url.pathname.startsWith("/ws/")) {
            const res = await handleWsUpgrade(req, url, server);
            if (res !== undefined) return res;
        }

        // ── REST endpoints ─────────────────────────────────────────────────────
        const res = await handleApi(req, url);
        if (res !== undefined) return res;

        return Response.json({ error: "Not found" }, { status: 404 });
    },

    websocket: {
        open: onOpen,
        message: onMessage,
        close: onClose,
    },
});

console.log(`PizzaPi server running on http://localhost:${server.port}`);
