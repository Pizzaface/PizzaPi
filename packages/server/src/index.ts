import { getTrustedOrigins } from "./auth.js";
import { handleFetch } from "./handler.js";
import {
    getEphemeralSweepIntervalMs,
    pruneExpiredRelaySessions,
} from "./sessions/store.js";
import { deleteRelayEventCaches, initializeRelayRedisCache } from "./sessions/redis.js";
import { sweepExpiredSessions } from "./ws/sio-registry.js";
import { sweepExpiredAttachments, rehydrateExtractedAttachments } from "./attachments/store.js";
import { runAllMigrations } from "./migrations.js";

// ── Process-level safety net ─────────────────────────────────────────────────
// The Socket.IO Redis adapter can throw EPIPE synchronously when the Redis
// connection drops mid-broadcast. We catch any that slip through call-site
// try/catches so the server never exits on a transient Redis disconnect.
process.on("uncaughtException", (err: Error) => {
    if ((err as NodeJS.ErrnoException).code === "EPIPE") {
        console.warn("[process] Caught EPIPE (Redis connection dropped) — ignoring:", err.message);
        return;
    }
    // Re-throw anything that isn't an EPIPE so genuine bugs still surface.
    console.error("[process] Uncaught exception:", err);
    process.exit(1);
});

// Socket.IO imports
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { registerNamespaces } from "./ws/namespaces/index.js";
import { initSioRegistry } from "./ws/sio-registry.js";
import { initStateRedis } from "./ws/sio-state.js";

const PORT = parseInt(process.env.PORT ?? "7492");

// ── Server health state ───────────────────────────────────────────────────
// The re-export below makes serverHealth available to callers who import from
// this entry point (e.g. tests), while the local import lets startup code
// mutate the flags directly.  Both statements reference the same module so
// there is only one shared object at runtime — not two copies.
export { serverHealth } from "./health.js";
import { serverHealth } from "./health.js";

await runAllMigrations();
void initializeRelayRedisCache();

// Rehydrate extracted image attachments from SQLite so URLs in persisted
// session state survive server restarts.
try {
    const count = await rehydrateExtractedAttachments();
    if (count > 0) console.log(`[startup] Rehydrated ${count} extracted image attachment(s) from database.`);
} catch (err) {
    console.error("[startup] Failed to rehydrate extracted attachments:", err);
}

// ── Helpers: convert node:http request/response ↔ fetch API ──────────────

function nodeReqToFetchRequest(req: IncomingMessage): Request {
    const proto = req.headers["x-forwarded-proto"] ?? "http";
    const host = req.headers.host ?? `localhost:${PORT}`;
    const url = new URL(req.url ?? "/", `${proto}://${host}`);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (key.toLowerCase() === "x-pizzapi-client-ip") continue; // Prevent spoofing
        if (Array.isArray(value)) {
            for (const v of value) headers.append(key, v);
        } else {
            headers.set(key, value);
        }
    }

    // Securely attach the real client IP so downstream routes can use it for rate limiting, etc.
    if (req.socket.remoteAddress) {
        headers.set("x-pizzapi-client-ip", req.socket.remoteAddress);
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
    const headers: Record<string, string | string[]> = {
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "x-xss-protection": "0",
        "referrer-policy": "strict-origin-when-cross-origin"
    };
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

// ── Single HTTP server (REST + Socket.IO on one port) ─────────────────────

const REDIS_URL = process.env.PIZZAPI_REDIS_URL ?? "redis://localhost:6379";

// Use trustedOrigins from auth.ts as the single source of truth for CORS

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
            res.writeHead(500, {
                "content-type": "application/json",
                "x-content-type-options": "nosniff",
                "x-frame-options": "DENY",
                "x-xss-protection": "0",
                "referrer-policy": "strict-origin-when-cross-origin"
            });
        }
        res.end(JSON.stringify({ error: "Internal server error" }));
    }
});

let io: SocketIOServer | undefined;

try {
    const pubClient = createClient({ url: REDIS_URL });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);

    // TODO: serverHealth.redis is set once at startup and never updated at
    // runtime.  If Redis disconnects after initialization this flag stays true
    // and /health will incorrectly report status "ok".  Tracking runtime state
    // would require attaching listeners to the Redis client ("error",
    // "reconnecting", "ready") which needs a design review before
    // implementation to avoid masking transient blips as permanent failures.
    serverHealth.redis = true;

    try {
        io = new SocketIOServer(httpServer, {
            cors: {
                origin: getTrustedOrigins(),
                credentials: true,
            },
            // Socket.IO default maxHttpBufferSize is 1 MB, which silently drops
            // connections when a session state payload exceeds it (e.g., sessions
            // with embedded screenshots can easily reach 10–50 MB). The transport
            // close happens with no error surfaced to the user. Bump to 100 MB
            // as a safety valve so large sessions remain accessible.
            maxHttpBufferSize: 100 * 1024 * 1024, // 100 MB
            // Generous ping settings to prevent disconnects during heavy agent
            // processing (long bash commands, large file reads, etc.).
            // Defaults are pingInterval=25s, pingTimeout=20s which is too tight
            // when the runner/worker event loop is briefly saturated.
            pingInterval: 30_000,   // 30 s between pings
            pingTimeout: 60_000,    // 60 s to respond before disconnect
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

        // TODO: same caveat as serverHealth.redis above — write-once at startup.
        serverHealth.socketio = true;
    } catch (sioErr) {
        console.error("[Socket.IO] Failed to initialize Socket.IO layer:", sioErr);
        console.error("[Socket.IO] The server will continue without real-time Socket.IO support.");
    }
} catch (err) {
    console.error("[Socket.IO] Failed to connect to Redis:", err);
    console.error("[Socket.IO] The server will continue without Redis and Socket.IO support.");
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
