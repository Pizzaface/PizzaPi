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
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

// ── Helpers: convert node:http request/response ↔ fetch API ──────────────

function nodeReqToFetchRequest(req: IncomingMessage): Request {
    const proto = req.headers["x-forwarded-proto"] ?? "http";
    const host = req.headers.host ?? `localhost:${PORT}`;
    const url = new URL(req.url ?? "/", `${proto}://${host}`);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            for (const v of value) headers.append(key, v);
        } else {
            headers.set(key, value);
        }
    }

    const method = (req.method ?? "GET").toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";

    return new Request(url.toString(), {
        method,
        headers,
        body: hasBody ? req as any : undefined,
        // @ts-expect-error — Bun supports duplex on Request
        duplex: hasBody ? "half" : undefined,
    });
}

async function sendFetchResponse(res: ServerResponse, response: Response): Promise<void> {
    const headers: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => {
        const existing = headers[key];
        if (existing !== undefined) {
            headers[key] = Array.isArray(existing)
                ? [...existing, value]
                : [existing, value];
        } else {
            headers[key] = value;
        }
    });

    res.writeHead(response.status, headers);

    if (!response.body) {
        res.end();
        return;
    }

    // Stream the response body
    const reader = response.body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
        }
    } finally {
        reader.releaseLock();
        res.end();
    }
}

// ── Fetch-style request handler (reuses existing REST + auth logic) ──────

async function handleFetch(req: Request): Promise<Response> {
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
}

// ── Single HTTP server (REST + Socket.IO on one port) ─────────────────────

const REDIS_URL = process.env.PIZZAPI_REDIS_URL ?? "redis://localhost:6379";

const CORS_ORIGINS = [
    process.env.PIZZAPI_BASE_URL ?? "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://jordans-mac-mini.tail65556b.ts.net:5173",
    "https://jordans-mac-mini.tail65556b.ts.net:5173",
    "https://jordans-mac-mini.tail65556b.ts.net",
];

const httpServer = createServer(async (req, res) => {
    // Socket.IO handles its own /socket.io/ paths automatically (via the
    // listener it attaches to httpServer). For all other requests, convert
    // to the fetch API and run through the existing REST + auth handlers.
    try {
        const fetchReq = nodeReqToFetchRequest(req);
        const fetchRes = await handleFetch(fetchReq);
        await sendFetchResponse(res, fetchRes);
    } catch (e) {
        console.error("[http] Unhandled error:", e);
        if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: "Internal server error" }));
    }
});

let io: SocketIOServer | undefined;

try {
    const pubClient = createClient({ url: REDIS_URL });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);

    io = new SocketIOServer(httpServer, {
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
} catch (err) {
    console.error("[Socket.IO] Failed to initialize (Redis may be unavailable):", err);
    console.error("[Socket.IO] The server will continue without Socket.IO support.");
}

httpServer.listen(PORT, () => {
    console.log(`PizzaPi server running on http://localhost:${PORT}`);
});

// ── Periodic maintenance ──────────────────────────────────────────────────

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

console.log(`Relay session maintenance enabled (every ${Math.round(sweepMs / 1000)}s).`);
