import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { createTestAuthContext, runWithAuthContext } from "../auth.js";
import { runAllMigrations } from "../migrations.js";

describe("cookie-auth upgrade origin gate (CSWSH)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-tunnelws-cswsh-"));
    const authContext = createTestAuthContext({
        dbPath: join(tmpDir, "test.db"),
        baseURL: "http://localhost:7496",
        extraOrigins: ["https://app.example.com"],
    });

    beforeAll(async () => {
        await runAllMigrations(authContext);
    });

    afterAll(() => {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    /**
     * Drive a tunnel upgrade with the given headers and return whatever was
     * written to the raw socket (the rejection line, e.g. "HTTP/1.1 403 ...").
     * A full successful handshake needs a runner/Redis, so "gate accepted" is
     * asserted as NOT being a 403 (auth then 401s on the bogus credential).
     */
    async function attemptUpgrade(url: string, headers: Record<string, string>): Promise<string> {
        const { handleTunnelWsUpgrade } = await import("./tunnel-ws.js");
        const chunks: Buffer[] = [];
        const socket = new Duplex({
            read() {},
            write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
        });
        const handled = runWithAuthContext(authContext, () =>
            handleTunnelWsUpgrade({ url, headers } as any, socket, Buffer.alloc(0)),
        );
        expect(handled).toBe(true);
        for (let i = 0; i < 100 && chunks.length === 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        socket.destroy();
        return Buffer.concat(chunks).toString("utf8");
    }

    const TUNNEL_URL = "/api/tunnel/session-123/3000/__vite_hmr";
    const WS_HEADERS = { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
    const COOKIE = { cookie: "pizzapi.session_token=bogus" };

    test("cookie-auth + untrusted Origin -> 403", async () => {
        const out = await attemptUpgrade(TUNNEL_URL, {
            ...WS_HEADERS,
            ...COOKIE,
            origin: "https://evil.example.com",
        });
        expect(out).toStartWith("HTTP/1.1 403");
    });

    test("cookie-auth + trusted Origin -> gate passes (not 403)", async () => {
        const out = await attemptUpgrade(TUNNEL_URL, {
            ...WS_HEADERS,
            ...COOKIE,
            origin: "https://app.example.com",
        });
        expect(out).toStartWith("HTTP/1.1 401");
    });

    test("cookie-auth + no Origin + Sec-Fetch-Site cross-site -> 403", async () => {
        const out = await attemptUpgrade(TUNNEL_URL, {
            ...WS_HEADERS,
            ...COOKIE,
            "sec-fetch-site": "cross-site",
        });
        expect(out).toStartWith("HTTP/1.1 403");
    });

    test("cookie-auth + no Origin/Sec-Fetch-Site (curl-style) -> gate passes", async () => {
        const out = await attemptUpgrade(TUNNEL_URL, { ...WS_HEADERS, ...COOKIE });
        expect(out).toStartWith("HTTP/1.1 401");
    });

    test("x-api-key header + cookie + untrusted Origin -> gate skipped", async () => {
        const out = await attemptUpgrade(TUNNEL_URL, {
            ...WS_HEADERS,
            ...COOKIE,
            "x-api-key": "bogus-key",
            origin: "https://evil.example.com",
        });
        expect(out).toStartWith("HTTP/1.1 401");
    });

    test("query-string apiKey does NOT exempt the origin gate", async () => {
        const out = await attemptUpgrade(`${TUNNEL_URL}?apiKey=bogus-key`, {
            ...WS_HEADERS,
            ...COOKIE,
            origin: "https://evil.example.com",
        });
        expect(out).toStartWith("HTTP/1.1 403");
    });

    test("no cookie + untrusted Origin -> gate skipped (nothing to ride)", async () => {
        const out = await attemptUpgrade(TUNNEL_URL, {
            ...WS_HEADERS,
            origin: "https://evil.example.com",
        });
        expect(out).toStartWith("HTTP/1.1 401");
    });

    test("runner-based path enforces the same gate", async () => {
        const out = await attemptUpgrade("/api/tunnel/runner/runner-1/3000/__vite_hmr", {
            ...WS_HEADERS,
            ...COOKIE,
            origin: "https://evil.example.com",
        });
        expect(out).toStartWith("HTTP/1.1 403");
    });
});

describe("tunnel-ws module exports", () => {
    test("exports the expected handler functions", async () => {
        const mod = await import("./tunnel-ws.js");
        expect(typeof mod.handleTunnelWsUpgrade).toBe("function");
    });
});

describe("handleTunnelWsUpgrade path matching", () => {
    test("returns false for non-tunnel paths", async () => {
        const { handleTunnelWsUpgrade } = await import("./tunnel-ws.js");
        const { Duplex } = await import("node:stream");

        const socket = new Duplex({
            read() {},
            write(_chunk, _enc, cb) { cb(); },
        });

        const result = handleTunnelWsUpgrade(
            { url: "/socket.io/?EIO=4&transport=websocket", headers: {} } as any,
            socket,
            Buffer.alloc(0),
        );
        expect(result).toBe(false);
        socket.destroy();
    });

    test("returns false for random API paths", async () => {
        const { handleTunnelWsUpgrade } = await import("./tunnel-ws.js");
        const { Duplex } = await import("node:stream");

        const socket = new Duplex({
            read() {},
            write(_chunk, _enc, cb) { cb(); },
        });

        const result = handleTunnelWsUpgrade(
            { url: "/api/sessions", headers: {} } as any,
            socket,
            Buffer.alloc(0),
        );
        expect(result).toBe(false);
        socket.destroy();
    });

    test("returns true for tunnel paths", async () => {
        const { handleTunnelWsUpgrade } = await import("./tunnel-ws.js");
        const { Duplex } = await import("node:stream");

        const socket = new Duplex({
            read() {},
            write(_chunk, _enc, cb) { cb(); },
        });

        const result = handleTunnelWsUpgrade(
            {
                url: "/api/tunnel/session-123/3000/__vite_hmr",
                headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
            } as any,
            socket,
            Buffer.alloc(0),
        );
        expect(result).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 200));
        socket.destroy();
    });

    test("returns true for tunnel paths with query strings", async () => {
        const { handleTunnelWsUpgrade } = await import("./tunnel-ws.js");
        const { Duplex } = await import("node:stream");

        const socket = new Duplex({
            read() {},
            write(_chunk, _enc, cb) { cb(); },
        });

        const result = handleTunnelWsUpgrade(
            {
                url: "/api/tunnel/sess-456/5173/__vite_hmr?token=abc",
                headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
            } as any,
            socket,
            Buffer.alloc(0),
        );
        expect(result).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 200));
        socket.destroy();
    });
});
