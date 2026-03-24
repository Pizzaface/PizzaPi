/**
 * Test server factory — creates a real PizzaPi server on an ephemeral port
 * with SQLite + Redis + Socket.IO for integration testing.
 *
 * IMPORTANT: createTestServer() uses module-level singletons from auth.ts and
 * sio-state.ts. Concurrent server creation is NOT supported — create servers
 * sequentially. Multiple servers can run simultaneously after creation; only
 * the creation phase must be serialized.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient, type RedisClientType } from "redis";

import { initAuth, getTrustedOrigins } from "../../src/auth.js";
import { runAllMigrations } from "../../src/migrations.js";
import { handleFetch } from "../../src/handler.js";
import { initStateRedis } from "../../src/ws/sio-state.js";
import { initSioRegistry } from "../../src/ws/sio-registry.js";
import { registerNamespaces } from "../../src/ws/namespaces/index.js";

import type { TestServerOptions, TestServer } from "./types.js";

const REDIS_URL = process.env.PIZZAPI_REDIS_URL ?? "redis://localhost:6379";

// ── Unique IP generator ──────────────────────────────────────────────────────
// The register rate limiter in routes/auth.ts is a module-level singleton
// (shared across all test server instances). We generate a unique IP per server
// so each creation gets its own rate-limit bucket and doesn't collide with others.
let _serverCounter = 0;
function uniqueTestClientIp(): string {
    const n = ++_serverCounter;
    return `10.255.${Math.floor(n / 256) % 256}.${n % 256}`;
}

// ── PIZZAPI_TRUST_PROXY env management ───────────────────────────────────────
// All test servers need PIZZAPI_TRUST_PROXY=true. To avoid env-restoration races
// when multiple servers are cleaned up concurrently (Promise.allSettled), we
// track the original value once at module load time and restore it only after
// the last active server is torn down.
//
// JS is single-threaded, so the _activeServers decrement + conditional restore
// in cleanup() is always atomic with respect to other cleanup() invocations.

const _trustProxyOriginal: string | undefined = process.env.PIZZAPI_TRUST_PROXY;
let _activeServers = 0;

function acquireTrustProxy(): void {
    if (_activeServers === 0) {
        // First server — set the env var
        process.env.PIZZAPI_TRUST_PROXY = "true";
    }
    _activeServers++;
}

function releaseTrustProxy(): void {
    _activeServers = Math.max(0, _activeServers - 1);
    if (_activeServers === 0) {
        // Last server cleaned up — restore original value
        if (_trustProxyOriginal === undefined) {
            delete process.env.PIZZAPI_TRUST_PROXY;
        } else {
            process.env.PIZZAPI_TRUST_PROXY = _trustProxyOriginal;
        }
    }
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
 * NOTE: Uses module-level singletons (auth, sio-state). Do NOT call this
 * concurrently — create servers sequentially to avoid race conditions.
 */
export async function createTestServer(opts?: TestServerOptions): Promise<TestServer> {
    // Acquire PIZZAPI_TRUST_PROXY — shared across all active test servers.
    // Must be matched by a releaseTrustProxy() call in cleanup() or error path.
    acquireTrustProxy();

    // Track all allocated resources so we can clean up on partial failure.
    let tmpDir: string | undefined;
    let pubClient: RedisClientType | undefined;
    let subClient: RedisClientType | undefined;
    let httpServer: ReturnType<typeof createServer> | undefined;
    let io: SocketIOServer | undefined;

    try {
        // 1. Temp directory for the SQLite DB
        tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-test-"));
        const dbPath = join(tmpDir, "test.db");

        // We need a placeholder baseURL for initAuth. We'll use a temp placeholder
        // that better-auth uses only for cookie domain (not for actual listening).
        // Using http://127.0.0.1 avoids port-0 issues and works for cookie matching.
        const placeholderBase = opts?.baseUrl ?? "http://127.0.0.1";

        // 2. Init auth with temp DB
        initAuth({
            dbPath,
            baseURL: placeholderBase,
            secret: "test-secret-for-harness-at-least-32-chars-long!!",
            disableSignupAfterFirstUser: opts?.disableSignupAfterFirstUser ?? true,
            extraOrigins: opts?.trustedOrigins,
        });

        // 3. Run DB migrations
        await runAllMigrations();

        // 4. Create Redis pub/sub clients.
        //    IMPORTANT: Do NOT use pubClient.duplicate() here. Other test files in
        //    the suite may mock the "redis" module (e.g. redis_perf.test.ts uses
        //    mock.module("redis", ...)), and mock objects typically omit .duplicate().
        //    Creating each client independently via createClient() avoids this
        //    dependency entirely.
        pubClient = createClient({ url: REDIS_URL }) as RedisClientType;
        subClient = createClient({ url: REDIS_URL }) as RedisClientType;
        await Promise.all([pubClient.connect(), subClient.connect()]);

        // 5. We'll track the resolved port for the request converter
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

        // 6. Create Socket.IO server with Redis adapter
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

        // 7. Init state Redis
        await initStateRedis();

        // 8. Init the Socket.IO registry
        initSioRegistry(io);

        // 9. Register all namespaces
        registerNamespaces(io);

        // 10. Listen on port 0 (OS assigns an ephemeral port) on IPv4 loopback
        await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));

        const addr = httpServer.address();
        if (!addr || typeof addr === "string") {
            throw new Error("[test-harness] Could not determine server port");
        }
        resolvedPort = addr.port;

        // Use 127.0.0.1 explicitly (not localhost) to avoid IPv6 resolution on macOS
        const baseUrl = opts?.baseUrl ?? `http://127.0.0.1:${resolvedPort}`;

        // 11. Create a test user via the /api/register endpoint.
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

        // 12. Get a session cookie via better-auth sign-in.
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
            // Release our hold on PIZZAPI_TRUST_PROXY. This is atomic (JS is
            // single-threaded) — the last cleanup() call to run restores the
            // original value; concurrent cleanups via Promise.allSettled are safe.
            releaseTrustProxy();

            // Close Socket.IO — this also closes the underlying httpServer internally,
            // so we do NOT call httpServer.close() separately (it would throw ERR_SERVER_NOT_RUNNING).
            await new Promise<void>((resolve) => io!.close(() => resolve()));

            // Disconnect Redis clients
            await Promise.allSettled([pubClient!.quit(), subClient!.quit()]);

            // Clean up temp directory
            try {
                rmSync(tmpDir!, { recursive: true, force: true });
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
            fetch: testFetch,
            cleanup,
        };

    } catch (err) {
        // ── Failure-safe teardown ────────────────────────────────────────────────
        // If setup fails at any point, clean up every resource that was allocated
        // before the failure, then re-throw so the caller sees the real error.

        releaseTrustProxy();

        // io.close() also closes the httpServer, so prefer it when available.
        if (io) {
            try { await new Promise<void>((resolve) => io!.close(() => resolve())); } catch { /* ignore */ }
        } else if (httpServer) {
            // io not yet created; close the bare HTTP server
            try { await new Promise<void>((resolve) => httpServer!.close(() => resolve())); } catch { /* ignore */ }
        }

        if (pubClient) { try { await pubClient.quit(); } catch { /* ignore */ } }
        if (subClient) { try { await subClient.quit(); } catch { /* ignore */ } }

        if (tmpDir) {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }

        throw err;
    }
}
