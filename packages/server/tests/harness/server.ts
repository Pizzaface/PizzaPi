/**
 * Test server factory — creates a real PizzaPi server on an ephemeral port
 * with SQLite + Redis + Socket.IO for integration testing.
 *
 * SINGLETON CONSTRAINT: Only ONE TestServer may be active at a time.
 * PizzaPi's auth.ts and sio-state.ts use module-level singletons that cannot
 * be shared or re-initialized across concurrent instances. Attempting to call
 * createTestServer() while a previous server is still active will throw.
 *
 * Intended usage pattern:
 *
 *   describe("my suite", () => {
 *     let server: TestServer;
 *     beforeAll(async () => { server = await createTestServer(); });
 *     afterAll(async () => { await server.cleanup(); });
 *     // ... tests ...
 *   });
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
// NOTE: We do NOT use a static top-level import of createClient from "redis" here.
// Several test files in packages/server/src/ws/ call mock.module("redis"), which
// permanently replaces the "redis" module in Bun's module registry for the entire
// worker process (Bun 1.3.x does NOT reset mock.module() between test files).
// If this file were statically bound to the mocked createClient, all harness tests
// in that worker would fail with "psubscribe/subscribe is not a function" from the
// Socket.IO Redis adapter constructor.
//
// The fix: preload-redis.ts (registered in packages/server/bunfig.toml) runs before
// any test file is loaded and saves the REAL createClient to globalThis. We retrieve
// it here at call time, bypassing the later mock. The dynamic import fallback is for
// cases where the preload is not present (e.g. running a single test file directly).
import type { RedisClientType, createClient as CreateClientType } from "redis";

import { initAuth, getTrustedOrigins } from "../../src/auth.js";
import { runAllMigrations } from "../../src/migrations.js";
import { handleFetch } from "../../src/handler.js";
import { initStateRedis, getStateRedis } from "../../src/ws/sio-state.js";
import { initSioRegistry } from "../../src/ws/sio-registry.js";
import { registerNamespaces } from "../../src/ws/namespaces/index.js";

import type { TestServerOptions, TestServer } from "./types.js";

const REDIS_URL = process.env.PIZZAPI_REDIS_URL ?? "redis://localhost:6379";

// ── Singleton guard ──────────────────────────────────────────────────────────
// auth.ts and sio-state.ts hold module-level singletons. Re-initializing them
// while a previous TestServer is active causes the older server to operate
// against the newer globals, producing SQLiteError disk I/O errors when the
// newer server's temp DB is removed on cleanup.
let _activeServer = false;

// ── Module-level env capture ─────────────────────────────────────────────────
// Capture PIZZAPI_TRUST_PROXY at module load (once) so that cleanup() always
// restores the genuine pre-test value — not an intermediate value written by
// a previous createTestServer() call. Per-server save/restore would drift if
// cleanup order ever diverged from creation order.
const _originalTrustProxy: string | undefined = process.env.PIZZAPI_TRUST_PROXY;

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
 * SINGLETON: Only one TestServer may be active at a time. Calling this while
 * a previous server is still running throws immediately. Call cleanup() on the
 * existing server first.
 */
export async function createTestServer(opts?: TestServerOptions): Promise<TestServer> {
    // ── Singleton guard ──────────────────────────────────────────────────────
    if (_activeServer) {
        throw new Error(
            "[test-harness] A TestServer is already active. " +
            "Call cleanup() on the existing server before creating another. " +
            "auth.ts and sio-state.ts use module-level singletons that cannot " +
            "be shared across concurrent TestServer instances.",
        );
    }
    _activeServer = true;

    // ── Setup with rollback on failure ───────────────────────────────────────
    // Track resources opened so far so we can close them if setup throws.
    let tmpDir: string | null = null;
    let pubClient: RedisClientType | null = null;
    let subClient: RedisClientType | null = null;
    let pubSubConnected = false;
    let httpServer: ReturnType<typeof createServer> | null = null;
    let io: SocketIOServer | null = null;
    let stateRedisInited = false;

    async function rollback(): Promise<void> {
        _activeServer = false;

        // Restore env (use the module-level original, not a per-server snapshot)
        if (_originalTrustProxy === undefined) {
            delete process.env.PIZZAPI_TRUST_PROXY;
        } else {
            process.env.PIZZAPI_TRUST_PROXY = _originalTrustProxy;
        }

        // Close Socket.IO (also closes httpServer)
        if (io) {
            await new Promise<void>((resolve) => io!.close(() => resolve())).catch(() => {});
        }

        // Close state Redis (guard against mock clients that lack .quit())
        if (stateRedisInited) {
            const sr = getStateRedis();
            if (sr && typeof (sr as unknown as Record<string, unknown>).quit === "function") {
                await sr.quit().catch(() => {});
            }
        }

        // Close pub/sub Redis (guard against mock clients that lack .quit())
        if (pubSubConnected) {
            await Promise.allSettled([
                (typeof pubClient?.quit === "function" ? pubClient.quit() : Promise.resolve()),
                (typeof subClient?.quit === "function" ? subClient.quit() : Promise.resolve()),
            ]);
        }

        // Clean up temp directory
        if (tmpDir) {
            try {
                rmSync(tmpDir, { recursive: true, force: true });
            } catch {
                // ignore
            }
        }
    }

    try {
        // 1. Temp directory for the SQLite DB
        tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-test-"));
        const dbPath = join(tmpDir, "test.db");

        // 2. Trust proxy for rate-limit tests (mirrors production behavior).
        //    Set process-wide; cleanup() will restore _originalTrustProxy.
        process.env.PIZZAPI_TRUST_PROXY = "true";

        // We need a placeholder baseURL for initAuth. We'll use a temp placeholder
        // that better-auth uses only for cookie domain (not for actual listening).
        // Using http://127.0.0.1 avoids port-0 issues and works for cookie matching.
        const placeholderBase = opts?.baseUrl ?? "http://127.0.0.1";

        // 3. Init auth with temp DB
        initAuth({
            dbPath,
            baseURL: placeholderBase,
            secret: "test-secret-for-harness-at-least-32-chars-long!!",
            disableSignupAfterFirstUser: opts?.disableSignupAfterFirstUser ?? true,
            extraOrigins: opts?.trustedOrigins,
        });

        // 4. Run DB migrations
        await runAllMigrations();

        // 5. Create Redis pub/sub clients and connect them.
        //
        // Retrieve the real createClient from the preload-saved global, or fall back
        // to a direct import. The preload (bunfig.toml) runs before any test file and
        // saves the real function before mock.module("redis") can replace it.
        //
        // Use two independent createClient() calls instead of .duplicate(). Some
        // mock stubs (and some redis client wrappers) lack .duplicate(); two
        // independent clients are functionally equivalent for the Socket.IO adapter.
        const _createClient: typeof CreateClientType =
            (globalThis as Record<string, unknown>).__realRedisCreateClient as typeof CreateClientType
            ?? (await import("redis") as typeof import("redis")).createClient;
        pubClient = _createClient({ url: REDIS_URL }) as RedisClientType;
        subClient = _createClient({ url: REDIS_URL }) as RedisClientType;
        await Promise.all([pubClient.connect(), subClient.connect()]);
        pubSubConnected = true;

        // 6. We'll track the resolved port for the request converter
        let resolvedPort = 0;

        // Create the HTTP server with the handleFetch handler
        httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            try {
                const fetchReq = await nodeReqToFetchRequest(req, resolvedPort);
                const fetchRes = await handleFetch(fetchReq);
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
        io = new SocketIOServer(httpServer, {
            cors: {
                origin: getTrustedOrigins(),
                credentials: true,
            },
            maxHttpBufferSize: 100 * 1024 * 1024,
            pingInterval: 30_000,
            pingTimeout: 60_000,
            adapter: createAdapter(pubClient, subClient, { key: "pizzapi-sio-test" }),
            transports: ["websocket", "polling"],
        });

        // 8. Init state Redis
        await initStateRedis();
        stateRedisInited = true;

        // 9. Init the Socket.IO registry
        initSioRegistry(io);

        // 10. Register all namespaces
        registerNamespaces(io);

        // 11. Listen on port 0 (OS assigns an ephemeral port) on IPv4 loopback
        await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));

        const addr = httpServer.address();
        if (!addr || typeof addr === "string") {
            throw new Error("[test-harness] Could not determine server port");
        }
        resolvedPort = addr.port;

        // Use 127.0.0.1 explicitly (not localhost) to avoid IPv6 resolution on macOS
        const baseUrl = opts?.baseUrl ?? `http://127.0.0.1:${resolvedPort}`;

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
            // Restore PIZZAPI_TRUST_PROXY to the original pre-test value
            if (_originalTrustProxy === undefined) {
                delete process.env.PIZZAPI_TRUST_PROXY;
            } else {
                process.env.PIZZAPI_TRUST_PROXY = _originalTrustProxy;
            }

            // Close Socket.IO — this also closes the underlying httpServer internally,
            // so we do NOT call httpServer.close() separately (it would throw ERR_SERVER_NOT_RUNNING).
            await new Promise<void>((resolve) => io!.close(() => resolve()));

            // Close state Redis (prevents process hang; guard against mock clients)
            const stateRedis = getStateRedis();
            if (stateRedis && typeof (stateRedis as unknown as Record<string, unknown>).quit === "function") {
                await stateRedis.quit().catch(() => {});
            }

            // Disconnect pub/sub Redis clients (guard against mock clients)
            await Promise.allSettled([
                (typeof pubClient?.quit === "function" ? pubClient.quit() : Promise.resolve()),
                (typeof subClient?.quit === "function" ? subClient.quit() : Promise.resolve()),
            ]);

            // Clean up temp directory
            try {
                rmSync(tmpDir!, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors
            }

            // Release the singleton guard so a new TestServer can be created
            _activeServer = false;
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
            fetch: testFetch,
            cleanup,
        };
    } catch (err) {
        await rollback();
        throw err;
    }
}
