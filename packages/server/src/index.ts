import type { WsData } from "./ws/registry.js";
import { onClose, onMessage, onOpen } from "./ws/relay.js";
import { auth } from "./auth.js";
import { handleWsUpgrade } from "./routes/ws.js";
import { handleApi } from "./routes/api.js";
import {
    ensureRelaySessionTables,
    getEphemeralSweepIntervalMs,
    pruneExpiredRelaySessions,
} from "./sessions/store.js";
import { sweepExpiredSharedSessions } from "./ws/registry.js";

const PORT = parseInt(process.env.PORT ?? "3000");

await ensureRelaySessionTables();

const server = Bun.serve<WsData>({
    port: PORT,

    async fetch(req, server) {
        const url = new URL(req.url);

        // ── better-auth handler ────────────────────────────────────────────────
        if (url.pathname.startsWith("/api/auth")) {
            try {
                return await auth.handler(req);
            } catch (e) {
                console.error("[auth] handler threw:", e);
                return Response.json({ error: "Auth error" }, { status: 500 });
            }
        }

        // ── WebSocket upgrades ─────────────────────────────────────────────────
        if (url.pathname.startsWith("/ws/")) {
            const res = await handleWsUpgrade(req, url, server);
            if (res !== undefined) return res;
        }

        // ── REST endpoints ─────────────────────────────────────────────────────
        try {
            const res = await handleApi(req, url);
            if (res !== undefined) return res;
        } catch (e) {
            console.error("[api] handleApi threw:", e);
            return Response.json({ error: "Internal server error" }, { status: 500 });
        }

        return Response.json({ error: "Not found" }, { status: 404 });
    },

    websocket: {
        open: onOpen,
        message: onMessage,
        close: onClose,
    },
});

const sweepMs = getEphemeralSweepIntervalMs();
setInterval(() => {
    sweepExpiredSharedSessions();
    void pruneExpiredRelaySessions().catch((error) => {
        console.error("Failed to prune expired relay sessions", error);
    });
}, sweepMs);

console.log(`PizzaPi server running on http://localhost:${server.port}`);
console.log(`Relay session maintenance enabled (every ${Math.round(sweepMs / 1000)}s).`);
