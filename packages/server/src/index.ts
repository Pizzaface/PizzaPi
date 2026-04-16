import { createAuthContext, runWithAuthContext } from "./auth.js";
import { handleFetch } from "./handler.js";
import {
    getEphemeralSweepIntervalMs,
    pruneExpiredRelaySessions,
} from "./sessions/store.js";
import { deleteRelayEventCaches, initializeRelayRedisCache } from "./sessions/redis.js";
import { sweepExpiredSessions, sweepOrphanedRunners } from "./ws/sio-registry.js";
import { sweepExpiredAttachments, rehydrateExtractedAttachments } from "./attachments/store.js";
import { runAllMigrations } from "./migrations.js";

import { setServerShuttingDown } from "./health.js";
import { handleTunnelWsUpgrade } from "./routes/tunnel-ws.js";
import { createLogger } from "@pizzapi/tools";
import {
    disposeTunnelRelay,
    handleTunnelRelayUpgrade,
    initTunnelRelay,
} from "./tunnel-relay.js";

// ── Process-level safety net ─────────────────────────────────────────────────
// The Socket.IO Redis adapter can throw EPIPE synchronously when the Redis
// connection drops mid-broadcast. We catch any that slip through call-site
// try/catches so the server never exits on a transient Redis disconnect.
//
// Known recoverable errors (per-request / transient network) are logged and
// swallowed so a single bad request cannot bring down the whole server.
// Truly fatal errors trigger a graceful shutdown with a 10 s drain window
// rather than an immediate process.exit so in-flight requests can complete.

process.on("uncaughtException", (err: Error) => {
    const code = (err as NodeJS.ErrnoException).code;

    // EPIPE — Redis/socket write to a closed pipe.  Always per-connection;
    // never indicates server-state damage.  Log and continue.
    if (code === "EPIPE") {
        processLog.warn("Caught EPIPE (Redis connection dropped) — ignoring:", err.message);
        return;
    }

    // Transient per-socket / per-stream network errors.  These should
    // normally be caught at the call site; reaching uncaughtException means
    // an error boundary was missed somewhere.  They are still connection-
    // scoped and do NOT corrupt shared server state, so we log at warn
    // level and continue rather than triggering a full shutdown.
    if (code === "ECONNRESET" || code === "ERR_STREAM_DESTROYED" || code === "ENOTCONN") {
        processLog.warn(`Caught transient network error (${code}) — logging and continuing:`, err.message);
        return;
    }

    // NOTE: SyntaxError / JSON parse failures are intentionally NOT handled
    // here.  At the uncaughtException level there is no reliable way to
    // determine whether a SyntaxError originated from a single malformed
    // request body (safe to swallow) or from startup / config / background
    // code (potentially corrupted state).  Malformed request bodies must be
    // caught at the request boundary (e.g. in handler.ts), not reclassified
    // as recoverable at process scope.

    // Fatal: initiate graceful shutdown instead of an immediate process.exit(1).
    // onShutdownSignal is a hoisted function declaration and is callable here
    // even though it is defined later in the file.  We wrap in try/catch as a
    // safety net for the narrow window during startup before httpServer exists.
    processLog.error("Uncaught fatal exception — initiating graceful shutdown:", err);
    try {
        onShutdownSignal("uncaughtException", 1);
    } catch (shutdownErr) {
        // Server not yet fully initialized (e.g. exception during migrations).
        // Fall back to immediate exit — there is nothing to drain.
        processLog.error("Graceful shutdown unavailable (server not ready) — exiting immediately:", shutdownErr);
        process.exit(1);
    }
});

// Socket.IO imports
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { registerNamespaces } from "./ws/namespaces/index.js";
import { initSioRegistry } from "./ws/sio-registry.js";
import { initStateRedis } from "./ws/sio-state/index.js";

const PORT = parseInt(process.env.PORT ?? "7492");

// ── Server health state ───────────────────────────────────────────────────
// The re-export below makes serverHealth available to callers who import from
// this entry point (e.g. tests), while the local import lets startup code
// mutate the flags directly.  Both statements reference the same module so
// there is only one shared object at runtime — not two copies.
export { serverHealth } from "./health.js";
import { serverHealth } from "./health.js";

const log = createLogger("index");
const processLog = createLogger("process");
const startupLog = createLogger("startup");
const httpLog = createLogger("http");
const healthLog = createLogger("health");
const socketIoLog = createLogger("Socket.IO");
const shutdownLog = createLogger("shutdown");

const authContext = createAuthContext();

await runAllMigrations(authContext);
void initializeRelayRedisCache();

// Rehydrate extracted image attachments from SQLite so URLs in persisted
// session state survive server restarts.
try {
    const count = await runWithAuthContext(authContext, () => rehydrateExtractedAttachments());
    if (count > 0) startupLog.info(`Rehydrated ${count} extracted image attachment(s) from database.`);
} catch (err) {
    startupLog.error("Failed to rehydrate extracted attachments:", err);
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
    // Security headers are already injected by withSecurityHeaders in handleFetch.
    // Do NOT add them here — duplicating would produce header arrays on the wire.
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

// ── Single HTTP server (REST + Socket.IO on one port) ─────────────────────

function getRedisUrl(): string { return process.env.PIZZAPI_REDIS_URL ?? "redis://localhost:6379"; }

// Use trustedOrigins from auth.ts as the single source of truth for CORS

const httpServer = createServer(async (req, res) => {
    // Socket.IO handles its own /socket.io/ paths automatically (via the
    // listener it attaches to httpServer). For all other requests, convert
    // to the fetch API and run through the existing REST + auth handlers.
    try {
        const fetchReq = nodeReqToFetchRequest(req);
        const fetchRes = await handleFetch(fetchReq, authContext);
        await sendFetchResponse(res, fetchRes);
    } catch (e) {
        httpLog.error("Unhandled error:", e);
        if (!res.headersSent) {
            res.writeHead(500, {
                "content-type": "application/json",
                "x-content-type-options": "nosniff",
                "x-frame-options": "DENY",
                "x-xss-protection": "0",
                "referrer-policy": "strict-origin-when-cross-origin",
                "permissions-policy": "camera=(), microphone=(), geolocation=()",
                "content-security-policy":
                    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss: blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'",
            });
        }
        res.end(JSON.stringify({ error: "Internal server error" }));
    }
});

let io: SocketIOServer | undefined;

// Tracks whether Socket.IO was successfully initialized so the Redis
// "ready" event handler can restore serverHealth.socketio on reconnect.
let sioInitialized = false;

try {
    const pubClient = createClient({ url: getRedisUrl() });
    const subClient = pubClient.duplicate();

    // ── Runtime health event listeners ────────────────────────────────────
    // Wire these BEFORE connecting so every state transition is captured,
    // including errors that happen during the initial connection attempt.
    //
    // Redis "ready"       → connection is established and accepting commands.
    // Redis "error"       → connection error (client will auto-reconnect).
    // Redis "reconnecting"→ client is actively attempting to reconnect.
    //
    // Socket.IO uses BOTH pubClient and subClient for its adapter — if either
    // disconnects, cross-node event propagation is degraded.  We track each
    // client's ready state independently and only report healthy when both
    // are connected.

    let pubReady = false;
    let subReady = false;

    function syncRedisHealth(): void {
        const allReady = pubReady && subReady;
        serverHealth.redis = allReady;
        if (sioInitialized) serverHealth.socketio = allReady;
    }

    pubClient.on("ready", () => {
        pubReady = true;
        syncRedisHealth();
        healthLog.info("Redis pub connected — health flags updated");
    });

    pubClient.on("error", (err: Error) => {
        const wasHealthy = serverHealth.redis;
        pubReady = false;
        syncRedisHealth();
        if (wasHealthy) {
            healthLog.warn("Redis pub connection error — health flags set to degraded:", err.message);
        }
    });

    pubClient.on("reconnecting", () => {
        pubReady = false;
        syncRedisHealth();
        healthLog.warn("Redis pub reconnecting — health flags set to degraded");
    });

    subClient.on("ready", () => {
        subReady = true;
        syncRedisHealth();
        healthLog.info("Redis sub connected — health flags updated");
    });

    subClient.on("error", (err: Error) => {
        const wasHealthy = serverHealth.redis;
        subReady = false;
        syncRedisHealth();
        if (wasHealthy) {
            healthLog.warn("Redis sub connection error — health flags set to degraded:", err.message);
        }
    });

    subClient.on("reconnecting", () => {
        subReady = false;
        syncRedisHealth();
        healthLog.warn("Redis sub reconnecting — health flags set to degraded");
    });

    await Promise.all([pubClient.connect(), subClient.connect()]);
    // Explicitly set flags to true after successful initial connection
    // (the "ready" events will have already fired, but this is a safety net).
    pubReady = true;
    subReady = true;
    serverHealth.redis = true;

    try {
        io = new SocketIOServer(httpServer, {
            cors: {
                origin: authContext.trustedOrigins,
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

        registerNamespaces(io, authContext);

        // Mark Socket.IO as initialized so the Redis event listeners above
        // can also flip serverHealth.socketio on future reconnects/disconnects.
        sioInitialized = true;
        serverHealth.socketio = true;
    } catch (sioErr) {
        socketIoLog.error("Failed to initialize Socket.IO layer:", sioErr);
        socketIoLog.error("The server will continue without real-time Socket.IO support.");
    }
} catch (err) {
    socketIoLog.error("Failed to connect to Redis:", err);
    socketIoLog.error("The server will continue without Redis and Socket.IO support.");
}

initTunnelRelay(authContext);

// ── WebSocket upgrade interception ───────────────────────────────────────
// Socket.IO attaches its own 'upgrade' listener to httpServer.
// We intercept the streaming relay endpoint first, then viewer tunnel WS
// proxy paths, then delegate everything else back to Socket.IO.
const existingUpgradeListeners = httpServer.listeners("upgrade").slice();
httpServer.removeAllListeners("upgrade");

httpServer.on("upgrade", (req, socket, head) => {
    if (runWithAuthContext(authContext, () => handleTunnelRelayUpgrade(req, socket, head))) {
        return;
    }

    if (runWithAuthContext(authContext, () => handleTunnelWsUpgrade(req, socket, head))) {
        return;
    }

    for (const listener of existingUpgradeListeners) {
        (listener as Function).call(httpServer, req, socket, head);
    }
});

httpServer.listen(PORT, () => {
    log.info(`PizzaPi server running on http://localhost:${PORT}`);
});

// ── Periodic maintenance ──────────────────────────────────────────────────

const sweepMs = getEphemeralSweepIntervalMs();
setInterval(() => {
    void runWithAuthContext(authContext, async () => {
        void sweepExpiredSessions();
        void sweepExpiredAttachments();
        void pruneExpiredRelaySessions()
            .then((expiredIds) => {
                if (expiredIds.length === 0) return;
                return deleteRelayEventCaches(expiredIds);
            })
            .catch((error) => {
                log.error("Failed to prune expired relay sessions", error);
            });
    });
}, sweepMs);

log.info(`Relay session maintenance enabled (every ${Math.round(sweepMs / 1000)}s).`);

// ── Post-startup orphaned runner sweep ───────────────────────────────────────
// After a graceful shutdown, runner Redis entries are intentionally preserved
// so reconnecting runners find their state intact.  But if the previous
// server was stopped permanently (not restarted), or a runner died, those
// entries become ghosts.  Give runners a 90-second grace period to reconnect,
// then prune any that didn't.
const RUNNER_RECONNECT_GRACE_MS = 90_000;
setTimeout(() => {
    void runWithAuthContext(authContext, () => sweepOrphanedRunners()).catch((err) => {
        startupLog.error("Failed to sweep orphaned runners:", err);
    });
}, RUNNER_RECONNECT_GRACE_MS);

// ── Graceful shutdown ────────────────────────────────────────────────────────
// Registered after httpServer and io are initialized so there's no TDZ risk
// if SIGTERM arrives during startup.  Sets isServerShuttingDown before closing
// Socket.IO so disconnect handlers can skip destructive Redis cleanup.

// Guards against re-entrant shutdown (e.g. SIGTERM followed by SIGINT, or
// SIGTERM followed by an uncaughtException during the drain window).
let shuttingDown = false;

function onShutdownSignal(signal: string, exitCode = 0): void {
    if (shuttingDown) {
        shutdownLog.warn(`Received ${signal} during shutdown — ignoring duplicate signal`);
        return;
    }
    shuttingDown = true;

    shutdownLog.info(`Received ${signal} — marking server as shutting down`);
    setServerShuttingDown();
    disposeTunnelRelay();

    // Helper: close the HTTP server and wait for in-flight requests to drain.
    // `httpServer.close()` stops accepting new connections but keeps existing
    // ones alive until they finish.  `closeIdleConnections()` immediately
    // releases keep-alive connections that are not currently serving a
    // request, so the close callback fires as soon as the last in-flight
    // request completes rather than waiting for clients to time out.
    function closeHttp(cb: () => void): void {
        httpServer.close(cb);
        // closeIdleConnections was added in Node 18.2 / Bun equivalent.
        // Optional chaining ensures forward-compat without a runtime check.
        (httpServer as any).closeIdleConnections?.();
    }

    // Close the Socket.IO server so disconnect handlers fire with the
    // shuttingDown flag already set, then close the HTTP server so
    // in-flight requests have a chance to complete before exit.
    if (io) {
        io.close(() => {
            shutdownLog.info("Socket.IO closed");
            closeHttp(() => {
                shutdownLog.info("HTTP server closed — all connections drained");
                process.exit(exitCode);
            });
        });
    } else {
        closeHttp(() => {
            shutdownLog.info("HTTP server closed — all connections drained");
            process.exit(exitCode);
        });
    }

    // Force exit after 10s if graceful shutdown stalls
    setTimeout(() => {
        shutdownLog.warn("Graceful shutdown timed out — forcing exit");
        process.exit(1);
    }, 10_000).unref();
}

process.on("SIGTERM", () => onShutdownSignal("SIGTERM"));
process.on("SIGINT", () => onShutdownSignal("SIGINT"));
