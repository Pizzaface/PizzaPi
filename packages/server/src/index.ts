import { auth } from "./auth.js";
import { handleApi } from "./routes/api.js";
import {
    ensureRelaySessionTables,
    getEphemeralSweepIntervalMs,
    pruneExpiredRelaySessions,
} from "./sessions/store.js";
import { deleteRelayEventCaches, initializeRelayRedisCache } from "./sessions/redis.js";
import { sweepExpiredSessions } from "./ws/sio-registry.js";
import { sweepExpiredAttachments } from "./attachments/store.js";
import { ensurePushSubscriptionTable } from "./push.js";

// Socket.IO imports
import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { registerNamespaces } from "./ws/namespaces/index.js";
import { initSioRegistry } from "./ws/sio-registry.js";
import { initStateRedis } from "./ws/sio-state.js";

const PORT = parseInt(process.env.PORT ?? "3000");

await ensureRelaySessionTables();
await ensurePushSubscriptionTable();
void initializeRelayRedisCache();

// ── HTTP server (REST API + auth) ─────────────────────────────────────────
const server = Bun.serve({
    port: PORT,

    async fetch(req) {
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
});

// ── Socket.IO server (node:http, separate port) ───────────────────────────
// Socket.IO cannot attach to Bun.serve() directly — it needs a node:http server.
// This runs on a separate port alongside the existing Bun.serve server.

const SIO_PORT = parseInt(process.env.PIZZAPI_SOCKETIO_PORT ?? String(PORT + 1));
const REDIS_URL = process.env.PIZZAPI_REDIS_URL ?? "redis://localhost:6379";

const CORS_ORIGINS = [
    process.env.PIZZAPI_BASE_URL ?? "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://jordans-mac-mini.tail65556b.ts.net:5173",
    "https://jordans-mac-mini.tail65556b.ts.net:5173",
    "https://jordans-mac-mini.tail65556b.ts.net",
];

const sioHttpServer = createServer();

let io: SocketIOServer | undefined;

try {
    const pubClient = createClient({ url: REDIS_URL });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);

    io = new SocketIOServer(sioHttpServer, {
        cors: {
            origin: CORS_ORIGINS,
            credentials: true,
        },
        connectionStateRecovery: {
            maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
            skipMiddlewares: true,
        },
        adapter: createAdapter(pubClient, subClient, { key: "pizzapi-sio" }),
        transports: ["websocket", "polling"],
    });

    // Initialize Redis-backed state layer for Socket.IO registry
    await initStateRedis();
    initSioRegistry(io);

    registerNamespaces(io);

    sioHttpServer.listen(SIO_PORT, () => {
        console.log(`Socket.IO server running on http://localhost:${SIO_PORT}`);
    });
} catch (err) {
    console.error("[Socket.IO] Failed to initialize (Redis may be unavailable):", err);
    console.error("[Socket.IO] The server will continue without Socket.IO support.");
}

const sweepMs = getEphemeralSweepIntervalMs();
setInterval(() => {
    void sweepExpiredSessions();
    void sweepExpiredAttachments();
    void pruneExpiredRelaySessions()
        .then((expiredIds) => {
            if (expiredIds.length === 0) return;
            return deleteRelayEventCaches(expiredIds);
        })
        .catch((error) => {
            console.error("Failed to prune expired relay sessions", error);
        });
}, sweepMs);

console.log(`PizzaPi server running on http://localhost:${server.port}`);
console.log(`Relay session maintenance enabled (every ${Math.round(sweepMs / 1000)}s).`);
