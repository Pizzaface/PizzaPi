/**
 * Test server factory — creates a real PizzaPi server on an ephemeral port
 * with SQLite + Redis + Socket.IO for integration testing.
 *
 * IMPORTANT: createTestServer() still uses a process-level Redis/state harness,
 * so only ONE active test server is supported at a time. Always call cleanup()
 * before creating a second server.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
// Type-only import — erased at compile time, no runtime module registry lookup.
import type { RedisClientType } from "redis";

import { createTestAuthContext, runWithAuthContext } from "../../src/auth.js";
import { runAllMigrations } from "../../src/migrations.js";
import { handleFetch } from "../../src/handler.js";
import { ensureBetterAuthCoreTables } from "./ensure-auth-tables.js";
import { initStateRedis, closeStateRedis } from "../../src/ws/sio-state/index.js";
import { serverHealth } from "../../src/health.js";
import { initSioRegistry } from "../../src/ws/sio-registry.js";
import { registerNamespaces } from "../../src/ws/namespaces/index.js";
import {
    initTunnelRelay,
    handleTunnelRelayUpgrade,
    disposeTunnelRelay,
} from "../../src/tunnel-relay.js";
import { handleTunnelWsUpgrade } from "../../src/routes/tunnel-ws.js";

import type { TestServerOptions, TestServer } from "./types.js";

// Read lazily so callers can set PIZZAPI_REDIS_URL before createTestServer() is called.
function getRedisUrl(): string {
    return process.env.PIZZAPI_REDIS_URL ?? "redis://localhost:6379";
}

// ── Active-server guard ──────────────────────────────────────────────────────
// The harness still shares process-level Redis/state plumbing, so only one
// active test server is supported at a time.
let _activeServer = false;

// ── Unique IP generator ──────────────────────────────────────────────────────
// The register rate limiter in routes/auth.ts is a module-level singleton
// (shared across all test server instances). We generate a unique IP per server
// so each creation gets its own rate-limit bucket and doesn't collide with others.
let _serverCounter = 0;
function uniqueTestClientIp(): string {
    const n = ++_serverCounter;
    return `10.255.${Math.floor(n / 256) % 256}.${n % 256}`;
}

// ── Node req/res ↔ fetch API helpers (mirrors src/index.ts) ─────────────────

async function nodeReqToFetchRequest(req: IncomingMessage, port: number): Promise<Request> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        // Prevent client-supplied x-pizzapi-client-ip spoofing
        if (key.toLowerCase() === "x-pizzapi-client-ip") continue;
        if (Array.isArray(value)) {
            for (const v of value) headers.append(key, v);
        } else {
            headers.set(key, value);
        }
    }

    // Inject real client IP from the TCP socket
    if (req.socket.remoteAddress) {
        headers.set("x-pizzapi-client-ip", req.socket.remoteAddress);
    }

    const method = (req.method ?? "GET").toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";

    // Pre-buffer the body from the Node.js stream into an ArrayBuffer.
    //
    // IMPORTANT: Do NOT pass the IncomingMessage stream directly as the Request
    // body. handler.ts notes a known Bun issue: when a Request with a
    // ReadableStream body is subsequently wrapped via `new Request(req, { headers })`
    // (as the auth handler does), the stream fails to propagate and hangs
    // indefinitely. Pre-buffering into an ArrayBuffer avoids this entirely.
    let body: ArrayBuffer | undefined;
    if (hasBody) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        }
        const buf = Buffer.concat(chunks);
        body = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    }

    return new Request(url.toString(), {
        method,
        headers,
        body,
    });
}

async function sendFetchResponse(res: ServerResponse, response: Response): Promise<void> {
    const headers: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => {
        const existing = headers[key];
        if (existing !== undefined) {
            headers[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
        } else {
            headers[key] = value;
        }
    });

    res.writeHead(response.status, headers);

    if (!response.body) {
        res.end();
        return;
    }

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

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a fully initialized PizzaPi test server on an ephemeral port.
 * Includes SQLite DB, Redis, Socket.IO, and a pre-created test user.
 *
 * Always call `cleanup()` when done to release all resources.
 *
 * NOTE: Only one active server is allowed at a time — an error is thrown if
 * you try to create a second without cleaning up the first.
 */
export async function createTestServer(opts?: TestServerOptions): Promise<TestServer> {
    if (_activeServer) {
        throw new Error(
            "[test-harness] Another test server is already active. " +
            "Call cleanup() on the existing server before creating a new one.",
        );
    }
    _activeServer = true;

    // 1. Temp directory for the SQLite DB
    const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-test-"));
    const dbPath = join(tmpDir, "test.db");

    // 2. Trust proxy for rate-limit tests (mirrors production behavior)
    const savedTrustProxy = process.env.PIZZAPI_TRUST_PROXY;
    process.env.PIZZAPI_TRUST_PROXY = "true";

    // Shared helper — restores PIZZAPI_TRUST_PROXY to its original value.
    // Called both from cleanup() on success and from the catch block on failure
    // so that a throw during setup never leaves a mutated env var behind.
    function restoreEnv(): void {
        if (savedTrustProxy === undefined) {
            delete process.env.PIZZAPI_TRUST_PROXY;
        } else {
            process.env.PIZZAPI_TRUST_PROXY = savedTrustProxy;
        }
    }

    // Use a placeholder baseURL for auth. Better Auth only needs a stable
    // origin for cookie handling; we can add the real ephemeral port to the
    // trusted-origins list after the server starts listening.
    const placeholderBase = opts?.baseUrl ?? "http://127.0.0.1";

    // Retrieve the real Redis createClient captured by the test preload
    // (packages/server/tests/harness/preload.ts).  Using the global avoids
    // the module-registry lookup entirely, which is immune to contamination
    // from mock.module("redis", …) calls in other test files sharing the
    // same Bun worker process.
    type CreateClientFn = typeof import("redis").createClient;
    const createClient = (
        (globalThis as unknown as Record<string, unknown>).__harnessRealCreateClient as CreateClientFn | undefined
        ?? (await import("redis")).createClient
    );

    // Hoisted so the catch block can close them if setup fails after connect.
    let pubClient: RedisClientType | null = null;
    let subClient: RedisClientType | null = null;

    try {

    // 3. Init auth with temp DB
    const authContext = createTestAuthContext({
        dbPath,
        baseURL: placeholderBase,
        secret: "test-secret-for-harness-at-least-32-chars-long!!",
        disableSignupAfterFirstUser: opts?.disableSignupAfterFirstUser ?? true,
        extraOrigins: opts?.trustedOrigins,
    });

    // 4. Run DB migrations
    await runAllMigrations(authContext);
    await ensureBetterAuthCoreTables(authContext.db);

    // 5. Create Redis pub/sub clients and connect them
    pubClient = createClient({ url: getRedisUrl() }) as RedisClientType;
    subClient = createClient({ url: getRedisUrl() }) as RedisClientType;
    await Promise.all([pubClient.connect(), subClient.connect()]);
    serverHealth.redis = true;

    // 6. We'll track the resolved port for the request converter
    let resolvedPort = 0;

    // Create the HTTP server with the handleFetch handler
    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        try {
            const fetchReq = await nodeReqToFetchRequest(req, resolvedPort);
            const fetchRes = await handleFetch(fetchReq, authContext);
            await sendFetchResponse(res, fetchRes);
        } catch (e) {
            console.error("[test-harness] Unhandled error:", e);
            if (!res.headersSent) {
                res.writeHead(500, { "content-type": "application/json" });
            }
            res.end(JSON.stringify({ error: "Internal server error" }));
        }
    });

    // 7. Create Socket.IO server with Redis adapter
    const io = new SocketIOServer(httpServer, {
        cors: {
            origin: authContext.trustedOrigins,
            credentials: true,
        },
        maxHttpBufferSize: 100 * 1024 * 1024,
        pingInterval: 30_000,
        pingTimeout: 60_000,
        adapter: createAdapter(pubClient, subClient, { key: `pizzapi-sio-test-${randomBytes(8).toString("hex")}` }),
        transports: ["websocket", "polling"],
    });

    // 8. Init state Redis
    await initStateRedis();

    // 9. Init the Socket.IO registry
    initSioRegistry(io);

    // 10. Register all namespaces
    registerNamespaces(io, authContext);
    serverHealth.socketio = true;

    // 10b. Init tunnel relay so mock runners can connect via /_tunnel WS
    initTunnelRelay(authContext);

    // 10c. Intercept WebSocket upgrades: tunnel relay first, then tunnel WS
    //      proxy, then fall through to Socket.IO (mirrors src/index.ts).
    const existingUpgradeListeners = httpServer.listeners("upgrade").slice();
    httpServer.removeAllListeners("upgrade");
    httpServer.on("upgrade", (req, socket, head) => {
        if (runWithAuthContext(authContext, () => handleTunnelRelayUpgrade(req, socket, head))) return;
        if (runWithAuthContext(authContext, () => handleTunnelWsUpgrade(req, socket, head))) return;
        for (const listener of existingUpgradeListeners) {
            (listener as Function).call(httpServer, req, socket, head);
        }
    });

    // 11. Listen on port 0 (OS assigns an ephemeral port) on IPv4 loopback
    const listenPort = opts?.port ?? 0;
    await new Promise<void>((resolve) => httpServer.listen(listenPort, "127.0.0.1", resolve));

    const addr = httpServer.address();
    if (!addr || typeof addr === "string") {
        throw new Error("[test-harness] Could not determine server port");
    }
    resolvedPort = addr.port;

    // Use 127.0.0.1 explicitly (not localhost) to avoid IPv6 resolution on macOS
    const baseUrl = opts?.baseUrl ?? `http://127.0.0.1:${resolvedPort}`;

    // Add the resolved baseUrl to better-auth's trusted origins so that
    // browser requests from the ephemeral port are accepted (not rejected
    // as "Invalid origin"). The auth context was created before we knew the
    // port, so the origin can't be included up front.
    const origins = authContext.trustedOrigins;
    if (!origins.includes(baseUrl)) {
        origins.push(baseUrl);
    }
    // Also add the localhost variant so browsers accessing via
    // http://localhost:{port} are accepted (not just 127.0.0.1).
    const localhostUrl = `http://localhost:${resolvedPort}`;
    if (!origins.includes(localhostUrl)) {
        origins.push(localhostUrl);
    }

    // 12. Create a test user via the /api/register endpoint.
    //     Use a unique client IP per server instance so each registration gets its
    //     own rate-limit bucket in the module-level registerRateLimiter singleton.
    const testUserName = "Test User";
    const testUserEmail = "testuser@pizzapi-harness.test";
    const testUserPassword = "HarnessPass123";
    const testClientIp = uniqueTestClientIp();

    const registerRes = await fetch(`${baseUrl}/api/register`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            // Unique x-forwarded-for per server so the rate limiter assigns a
            // separate bucket for each test server creation.
            "x-forwarded-for": testClientIp,
        },
        body: JSON.stringify({
            name: testUserName,
            email: testUserEmail,
            password: testUserPassword,
        }),
    });

    if (!registerRes.ok) {
        throw new Error(
            `[test-harness] Failed to create test user: ${registerRes.status} ${await registerRes.text()}`,
        );
    }

    const registerData = await registerRes.json() as { ok: boolean; key: string };
    const apiKey = registerData.key;

    // 13. Get a session cookie via better-auth sign-in.
    //     The sign-in response includes the user object (with id) and Set-Cookie header.
    const signInRes = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-forwarded-for": testClientIp,
        },
        body: JSON.stringify({
            email: testUserEmail,
            password: testUserPassword,
        }),
    });

    if (!signInRes.ok) {
        throw new Error(
            `[test-harness] Failed to sign in test user: ${signInRes.status} ${await signInRes.text()}`,
        );
    }

    const signInData = await signInRes.json() as { user?: { id: string } };
    const userId = signInData.user?.id ?? "";
    if (!userId) {
        throw new Error("[test-harness] Could not get userId from sign-in response");
    }

    const cookies = signInRes.headers.getSetCookie();
    const sessionCookie = cookies.join("; ");

    // ── Helpers ──────────────────────────────────────────────────────────────

    function addTrustedOrigin(origin: string): void {
        const origins = authContext.trustedOrigins;
        if (!origins.includes(origin)) {
            origins.push(origin);
        }
    }

    async function testFetch(path: string, init?: RequestInit): Promise<Response> {
        const url = `${baseUrl}${path}`;
        const headers = new Headers(init?.headers);

        // Inject auth headers if not already present
        if (!headers.has("x-pizzapi-api-key") && !headers.has("x-api-key")) {
            headers.set("x-pizzapi-api-key", apiKey);
        }
        if (!headers.has("cookie") && sessionCookie) {
            headers.set("cookie", sessionCookie);
        }

        return fetch(url, { ...init, headers });
    }

    // ── Cleanup ──────────────────────────────────────────────────────────────

    async function cleanup(): Promise<void> {
        // Clear the active-server guard so a new server can be created.
        _activeServer = false;

        // Restore PIZZAPI_TRUST_PROXY
        restoreEnv();

        // Gracefully disconnect Socket.IO clients first so their async
        // disconnect handlers can flush Redis-backed broadcasts before the
        // adapter clients are closed.
        await io.disconnectSockets(true);
        await new Promise<void>((resolve) => setTimeout(resolve, 100));

        // Close idle keep-alive HTTP connections so io.close() can complete
        // promptly without cutting active WebSocket traffic too early.
        const nodeHttpServer = io as unknown as {
            httpServer?: { closeIdleConnections?(): void; closeAllConnections?(): void };
        };
        nodeHttpServer.httpServer?.closeIdleConnections?.();

        // Close Socket.IO — this also closes the underlying httpServer internally,
        // so we do NOT call httpServer.close() separately (it would throw ERR_SERVER_NOT_RUNNING).
        await new Promise<void>((resolve) => io.close(() => resolve()));

        // Tear down tunnel relay WebSocket server
        disposeTunnelRelay();

        // Disconnect Redis clients (adapter pub/sub + dedicated state client)
        await Promise.allSettled([pubClient?.quit(), subClient?.quit(), closeStateRedis()]);

        // Clean up temp directory
        try {
            rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    }

    return {
        port: resolvedPort,
        baseUrl,
        io,
        apiKey,
        userId,
        userName: testUserName,
        userEmail: testUserEmail,
        sessionCookie,
        addTrustedOrigin,
        fetch: testFetch,
        cleanup,
    };

    } catch (err) {
        // Setup failed — clear guard, restore env var, tear down tunnel relay
        // (if initTunnelRelay() was called before the error), close all leaked
        // Redis clients (pub/sub + state), and clean up temp dir so state
        // doesn't contaminate tests.
        _activeServer = false;
        restoreEnv();
        disposeTunnelRelay();
        await Promise.allSettled([
            pubClient?.quit(),
            subClient?.quit(),
            closeStateRedis(),
        ]);
        try {
            rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
        throw err;
    }
}
