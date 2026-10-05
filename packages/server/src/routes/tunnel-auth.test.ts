/**
 * Auth behaviour of the runner-scoped tunnel proxy
 * (/api/tunnel/runner/:runnerId/:port/*) against a REAL better-auth instance:
 * browser cookie accepted, API key accepted, anonymous rejected, and the
 * proxied HTML gets its relative links rewritten under the runner prefix.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";

const RUNNER_ID = "runner-1";
const OFFLINE_RUNNER_ID = "runner-offline";
let ownerUserId = "";
let lastProxied: { path: string; headers: Record<string, string>; method: string; capabilityAgeMs?: number } | null = null;

const actualRegistry = await import("../ws/sio-registry.js");
mock.module("../ws/sio-registry.js", () => ({
    ...actualRegistry,
    getRunnerData: async (id: string) =>
        id === RUNNER_ID || id === OFFLINE_RUNNER_ID ? { runnerId: id, userId: ownerUserId } : null,
}));

mock.module("../tunnel-relay.js", () => ({
    getTunnelRelay: () => ({
        hasRunner: (id: string) => id === RUNNER_ID,
        proxyHttpRequest: (
            _runnerId: string,
            request: { method: string; url: string; headers: Record<string, string>; capabilityAgeMs?: number },
            cb: {
                onResponseStart: (code: number, message: string, headers: Record<string, string>) => void;
                onResponseData: (data: Buffer) => void;
                onResponseEnd: () => void;
            },
        ) => {
            lastProxied = { path: request.url, headers: request.headers, method: request.method, capabilityAgeMs: request.capabilityAgeMs };
            setTimeout(() => {
                cb.onResponseStart(200, "OK", { "content-type": "text/html" });
                cb.onResponseData(Buffer.from('<html><body><a href="/pic/a.png">p</a><img src="/r/x.html"></body></html>'));
                cb.onResponseEnd();
            }, 0);
            return { cancel() {} };
        },
        sendRequestData() {},
        sendRequestDataEnd() {},
    }),
}));

const { createTestAuthContext, runWithAuthContext } = await import("../auth.js");
const { runAllMigrations } = await import("../migrations.js");
const { handleApi } = await import("./index.js");
const { mintEphemeralApiKey } = await import("./utils.js");
const { handleTunnelWsUpgrade } = await import("./tunnel-ws.js");
const { isTunnelPath } = await import("../handler.js");

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-tunnel-auth-"));
const authContext = createTestAuthContext({ dbPath: join(tmpDir, "test.db"), baseURL: "http://localhost:7492" });
const BASE = `http://localhost:7492/api/tunnel/runner/${RUNNER_ID}/8477`;
let cookie = "";

beforeAll(async () => {
    await runAllMigrations(authContext);
    await runWithAuthContext(authContext, async () => {
        const res = await authContext.auth.api.signUpEmail({
            body: { email: "owner@example.com", password: "Password123!", name: "owner" },
            asResponse: true,
        });
        cookie = res.headers.get("set-cookie")!.split(";")[0];
        const session = await authContext.auth.api.getSession({ headers: new Headers({ cookie }) });
        ownerUserId = session!.user.id;
    });
});

afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

const call = (url: string, init?: RequestInit) =>
    runWithAuthContext(authContext, async () => {
        const req = new Request(url, init);
        return (await handleApi(req, new URL(req.url)))!;
    });

describe("runner tunnel auth", () => {
    test("anonymous → 401", async () => {
        const res = await call(`${BASE}/`);
        expect(res.status).toBe(401);
    });

    test("browser session cookie → 200 with links rewritten under the runner prefix, cookie not forwarded", async () => {
        const res = await call(`${BASE}/`, { headers: { cookie } });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain(`href="/api/tunnel/runner/${RUNNER_ID}/8477/pic/a.png"`);
        expect(html).toContain(`src="/api/tunnel/runner/${RUNNER_ID}/8477/r/x.html"`);
        expect(lastProxied!.path).toBe("/");
        expect(lastProxied!.headers["cookie"]).toBeUndefined();
    });

    test("API key → 200, key not forwarded, POST + sub-path proxied", async () => {
        const key = await runWithAuthContext(authContext, () => mintEphemeralApiKey(ownerUserId, "t", 60));
        const res = await call(`${BASE}/api/spotify/token?x=1&apiKey=leak`, {
            method: "POST",
            headers: { "x-api-key": key, "content-type": "application/json" },
            body: "{}",
        });
        expect(res.status).toBe(200);
        expect(lastProxied!.method).toBe("POST");
        expect(lastProxied!.path).toBe("/api/spotify/token?x=1");
        expect(lastProxied!.headers["x-api-key"]).toBeUndefined();
    });

    test("cookie from a non-owner → 403", async () => {
        const other = await runWithAuthContext(authContext, () =>
            authContext.auth.api.signUpEmail({
                body: { email: "other@example.com", password: "Password123!", name: "other" },
                asResponse: true,
            }),
        );
        const res = await call(`${BASE}/`, { headers: { cookie: other.headers.get("set-cookie")!.split(";")[0] } });
        expect(res.status).toBe(403);
    });

    test("tunnel-token mint honours ttlHours for the signed path token", async () => {
        const res = await call("http://localhost:7492/api/tunnel-token", {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ runnerId: RUNNER_ID, port: 8477, ttlHours: 168 }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { url: string; expiresAt: string };
        const ttlH = (new Date(body.expiresAt).getTime() - Date.now()) / 3_600_000;
        expect(ttlH).toBeGreaterThan(167);
        // The minted URL works with no credentials at all (phone browser).
        const proxied = await call(`http://localhost:7492${body.url}`);
        expect(proxied.status).toBe(200);
    });

    test("WebSocket upgrade with cookie passes auth on the runner path", async () => {
        const chunks: Buffer[] = [];
        const socket = new Duplex({ read() {}, write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
        runWithAuthContext(authContext, () =>
            handleTunnelWsUpgrade(
                {
                    url: `/api/tunnel/runner/${OFFLINE_RUNNER_ID}/8477/ws`,
                    headers: { cookie, "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
                } as never,
                socket,
                Buffer.alloc(0),
            ),
        );
        for (let i = 0; i < 100 && chunks.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
        socket.destroy();
        // Auth + ownership passed; only the (deliberately offline) relay check failed.
        expect(Buffer.concat(chunks).toString()).toStartWith("HTTP/1.1 503");
    });

    test("browser navigation to a cookie route is redirected to a signed, sandboxable token path", async () => {
        const res = await call(`${BASE}/app/page?x=1&apiKey=leak`, {
            headers: { cookie, "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
        });
        expect(res.status).toBe(302);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const location = res.headers.get("location")!;
        expect(location).toMatch(new RegExp(`^/api/tunnel/auth/[^/]+/runner%3A${RUNNER_ID}/8477/app/page\\?x=1$`));
        // The redirect target works without any cookie (opaque-origin subresources carry none).
        lastProxied = null;
        const followed = await call(`http://localhost:7492${location}`);
        expect(followed.status).toBe(200);
        expect(lastProxied!.path).toBe("/app/page?x=1");
    });

    test("navigation redirect still requires ownership (anonymous → 401, no token minted)", async () => {
        const res = await call(`${BASE}/`, { headers: { "sec-fetch-mode": "navigate" } });
        expect(res.status).toBe(401);
        expect(res.headers.get("location")).toBeNull();
    });

    test("token route grants CORS only to the opaque sandbox origin and answers its preflight", async () => {
        const mint = await call("http://localhost:7492/api/tunnel-token", {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ runnerId: RUNNER_ID, port: 8477 }),
        });
        const { url } = (await mint.json()) as { url: string };

        lastProxied = null;
        const preflight = await call(`http://localhost:7492${url}api/data`, {
            method: "OPTIONS",
            headers: { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe("null");
        expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type");
        expect(lastProxied).toBeNull();

        const opaque = await call(`http://localhost:7492${url}api/data`, { headers: { origin: "null" } });
        expect(opaque.headers.get("access-control-allow-origin")).toBe("null");
        expect(opaque.headers.get("access-control-allow-credentials")).toBe("true");

        const sameOrigin = await call(`http://localhost:7492${url}api/data`);
        expect(sameOrigin.headers.get("access-control-allow-origin")).toBeNull();
    });

    test("end to end: token-path documents are CSP-sandboxed and exempt from the cookie CSRF gate", async () => {
        const { handleFetch } = await import("../handler.js");
        const mint = await call("http://localhost:7492/api/tunnel-token", {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ runnerId: RUNNER_ID, port: 8477 }),
        });
        const { url } = (await mint.json()) as { url: string };
        const doc = await handleFetch(new Request(`http://localhost:7492${url}`), authContext);
        expect(doc.status).toBe(200);
        expect(doc.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
        expect(doc.headers.get("content-security-policy")).not.toContain("allow-same-origin");

        // A sandboxed document POSTs with Origin: null; a stray relay cookie
        // must not turn that into a CSRF rejection on the token route…
        const post = await handleFetch(new Request(`http://localhost:7492${url}api/save`, {
            method: "POST",
            headers: { cookie, origin: "null", "content-type": "application/json" },
            body: "{}",
        }), authContext);
        expect(post.status).toBe(200);
        // …while cookie-authenticated tunnel routes keep the gate.
        const cookiePost = await handleFetch(new Request(`${BASE}/api/save`, {
            method: "POST",
            headers: { cookie, origin: "null", "content-type": "application/json" },
            body: "{}",
        }), authContext);
        expect(cookiePost.status).toBe(403);
    });

    test("token routes tell the runner the capability's age; cookie routes do not (F04)", async () => {
        const mint = await call("http://localhost:7492/api/tunnel-token", {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ runnerId: RUNNER_ID, port: 8477 }),
        });
        const { url } = (await mint.json()) as { url: string };
        await call(`http://localhost:7492${url}`);
        expect(typeof lastProxied!.capabilityAgeMs).toBe("number");
        // iat has whole-second granularity.
        expect(lastProxied!.capabilityAgeMs!).toBeGreaterThanOrEqual(0);
        expect(lastProxied!.capabilityAgeMs!).toBeLessThan(5_000);

        await call(`${BASE}/`, { headers: { cookie } });
        expect(lastProxied!.capabilityAgeMs).toBeUndefined();
    });

    test("isTunnelPath covers runner- and token-scoped paths (no body buffering/cap)", () => {
        expect(isTunnelPath("/api/tunnel/runner/r/8477/api/feedback/voice")).toBe(true);
        expect(isTunnelPath("/api/tunnel/auth/tok/runner:r/8477/x")).toBe(true);
        expect(isTunnelPath("/api/tunnel/sess/3000/")).toBe(true);
        expect(isTunnelPath("/api/tunnel-token")).toBe(false);
    });
});
