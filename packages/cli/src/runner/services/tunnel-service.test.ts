/**
 * Tests for tunnel-service.ts:
 *  - httpProxy() standalone function
 *  - TunnelService response cache (LRU, TTL, invalidation)
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { httpProxy, TunnelService } from "./tunnel-service.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a minimal mock socket object. */
function createMockSocket() {
    const emitted: Array<[string, ...unknown[]]> = [];
    return {
        emitted,
        emit: mock((...args: unknown[]) => {
            emitted.push(args as [string, ...unknown[]]);
        }),
        on: mock(() => {}),
    };
}

/**
 * Create a TunnelService with a mock socket and a pre-exposed port,
 * bypassing the full socket.io event setup.
 */
function createServiceWithPort(port: number) {
    const service = new TunnelService();
    const socket = createMockSocket();
    // Inject socket and pre-register the port so requests are not rejected.
    (service as any).socket = socket;
    (service as any).tunnels.set(port, { port, url: `/tunnel/${port}` });
    return { service, socket };
}

// ── httpProxy() ────────────────────────────────────────────────────────────

describe("httpProxy()", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        (globalThis as any).fetch = originalFetch;
    });

    test("forces accept-encoding: identity regardless of caller header", async () => {
        let capturedHeaders: Record<string, string> = {};

        (globalThis as any).fetch = mock(async (_url: any, init: any) => {
            // init.headers is the forwardHeaders Record<string, string>
            capturedHeaders = { ...(init.headers as Record<string, string>) };
            return new Response("ok", { status: 200 });
        });

        await httpProxy(
            3000,
            "GET",
            "/",
            // Caller advertises gzip — the proxy must override it.
            { "accept-encoding": "gzip, br" },
            undefined,
        );

        expect(capturedHeaders["accept-encoding"]).toBe("identity");
    });

    // ── P2.2 security tests ───────────────────────────────────────────────

    test("SSRF guard: rejects path containing @ that would inject a different host", async () => {
        // No network call should be made; the SSRF check must short-circuit.
        (globalThis as any).fetch = mock(async () => {
            throw new Error("fetch should not be called");
        });

        // `/@evil.com/` causes `new URL("http://127.0.0.1:3000/@evil.com/")` to
        // produce hostname "127.0.0.1" (no injection), but a path like
        // `//evil.com/` or containing `@` can trick some parsers.
        // Specifically test the documented attack vector.
        const result = await httpProxy(3000, "GET", "/@evil.com/", {}, undefined);

        expect(result.status).toBe(400);
        expect(result.error).toMatch(/SSRF guard/i);
    });

    test("rejects response body that exceeds MAX_RESPONSE_BYTES (10 MB)", async () => {
        const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

        (globalThis as any).fetch = mock(async () => ({
            status: 200,
            headers: new Headers(),
            arrayBuffer: async () => new ArrayBuffer(MAX_RESPONSE_BYTES + 1),
        }));

        const result = await httpProxy(3000, "GET", "/big-file", {}, undefined);

        expect(result.status).toBe(413);
        expect(result.error).toMatch(/limit/i);
    });

    test("passes redirect: manual to fetch and returns 3xx responses without following", async () => {
        let capturedInit: RequestInit | undefined;

        (globalThis as any).fetch = mock(async (_url: any, init: any) => {
            capturedInit = init;
            return new Response(null, {
                status: 301,
                headers: { location: "http://other.internal/target" },
            });
        });

        const result = await httpProxy(3000, "GET", "/redirect-me", {}, undefined);

        expect(capturedInit?.redirect).toBe("manual");
        // 3xx must be passed back as-is, not silently followed
        expect(result.status).toBe(301);
    });

    test("strips authorization and cookie headers before forwarding", async () => {
        let capturedHeaders: Record<string, string> = {};

        (globalThis as any).fetch = mock(async (_url: any, init: any) => {
            capturedHeaders = { ...(init.headers as Record<string, string>) };
            return new Response("ok", { status: 200 });
        });

        await httpProxy(
            3000,
            "GET",
            "/protected",
            {
                authorization: "Bearer super-secret",
                cookie: "session=abc123",
                "x-custom-header": "should-pass-through",
            },
            undefined,
        );

        // Auth headers must be stripped
        expect(capturedHeaders["authorization"]).toBeUndefined();
        expect(capturedHeaders["cookie"]).toBeUndefined();
        // Non-auth, non-hop-by-hop headers must survive
        expect(capturedHeaders["x-custom-header"]).toBe("should-pass-through");
    });
});

// ── TunnelService response cache ───────────────────────────────────────────

describe("TunnelService response cache", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        (globalThis as any).fetch = originalFetch;
    });

    // ── Test 3 ────────────────────────────────────────────────────────────

    test("returns cached GET 200 on second call without hitting fetch again", async () => {
        let fetchCallCount = 0;

        (globalThis as any).fetch = mock(async () => {
            fetchCallCount++;
            return new Response("cached-body", { status: 200 });
        });

        const { service } = createServiceWithPort(3000);

        const baseRequest = {
            port: 3000,
            method: "GET",
            path: "/index.html",
            headers: {},
            body: undefined,
        };

        // First request — populates cache
        await (service as any).handleHttpRequest({ ...baseRequest, requestId: "r1" });
        expect(fetchCallCount).toBe(1);

        // Second identical request — must come from cache, no new fetch call
        await (service as any).handleHttpRequest({ ...baseRequest, requestId: "r2" });
        expect(fetchCallCount).toBe(1);
    });

    // ── Test 4 ────────────────────────────────────────────────────────────

    test("does not cache non-GET requests", async () => {
        let fetchCallCount = 0;

        (globalThis as any).fetch = mock(async () => {
            fetchCallCount++;
            return new Response("ok", { status: 200 });
        });

        const { service } = createServiceWithPort(3000);

        const baseRequest = {
            port: 3000,
            method: "POST",
            path: "/api/action",
            headers: {},
            body: undefined,
        };

        await (service as any).handleHttpRequest({ ...baseRequest, requestId: "r1" });
        await (service as any).handleHttpRequest({ ...baseRequest, requestId: "r2" });

        // POST must never be cached — fetch called for both requests
        expect(fetchCallCount).toBe(2);
    });

    // ── Test 5 (no-store) ─────────────────────────────────────────────────

    test("does not cache GET 200 when response has Cache-Control: no-store", async () => {
        let fetchCallCount = 0;

        (globalThis as any).fetch = mock(async () => {
            fetchCallCount++;
            return new Response("fresh", {
                status: 200,
                headers: { "cache-control": "no-store" },
            });
        });

        const { service } = createServiceWithPort(3000);

        const baseRequest = {
            port: 3000,
            method: "GET",
            path: "/api/dynamic",
            headers: {},
            body: undefined,
        };

        await (service as any).handleHttpRequest({ ...baseRequest, requestId: "r1" });
        await (service as any).handleHttpRequest({ ...baseRequest, requestId: "r2" });

        // no-store → not cached → fetch called twice
        expect(fetchCallCount).toBe(2);
    });

    test("does not cache GET 200 when response has Cache-Control: no-cache", async () => {
        let fetchCallCount = 0;

        (globalThis as any).fetch = mock(async () => {
            fetchCallCount++;
            return new Response("fresh", {
                status: 200,
                headers: { "cache-control": "no-cache" },
            });
        });

        const { service } = createServiceWithPort(3000);

        const baseRequest = {
            port: 3000,
            method: "GET",
            path: "/api/revalidate",
            headers: {},
            body: undefined,
        };

        await (service as any).handleHttpRequest({ ...baseRequest, requestId: "r1" });
        await (service as any).handleHttpRequest({ ...baseRequest, requestId: "r2" });

        // no-cache → not cached → fetch called twice
        expect(fetchCallCount).toBe(2);
    });

    // ── Test 6 ────────────────────────────────────────────────────────────

    test("invalidates all port entries from cache when port is unexposed", async () => {
        (globalThis as any).fetch = mock(async () => new Response("ok", { status: 200 }));

        const { service } = createServiceWithPort(3000);

        // Prime cache with two paths on port 3000
        await (service as any).handleHttpRequest({
            requestId: "r1",
            port: 3000,
            method: "GET",
            path: "/page-a",
            headers: {},
            body: undefined,
        });
        await (service as any).handleHttpRequest({
            requestId: "r2",
            port: 3000,
            method: "GET",
            path: "/page-b",
            headers: {},
            body: undefined,
        });

        const cache: Map<string, unknown> = (service as any).responseCache;
        expect(cache.has("3000:GET:/page-a")).toBe(true);
        expect(cache.has("3000:GET:/page-b")).toBe(true);

        // Unexpose port 3000 — all entries for this port must be evicted
        (service as any).handleUnexpose({ port: 3000 });

        expect(cache.has("3000:GET:/page-a")).toBe(false);
        expect(cache.has("3000:GET:/page-b")).toBe(false);
    });

    // ── P2.3: TTL expiry ──────────────────────────────────────────────────

    test("expired cache entries are not returned after TTL elapses", async () => {
        let fetchCallCount = 0;

        (globalThis as any).fetch = mock(async () => {
            fetchCallCount++;
            return new Response("body", { status: 200 });
        });

        const { service } = createServiceWithPort(3002);

        const baseRequest = {
            port: 3002,
            method: "GET",
            path: "/ttl-test",
            headers: {},
            body: undefined,
        };

        // First request — populates cache using real Date.now()
        await (service as any).handleHttpRequest({ ...baseRequest, requestId: "r1" });
        expect(fetchCallCount).toBe(1);

        // Advance Date.now() past CACHE_TTL_MS (60 000 ms) so the entry expires
        const realDateNow = Date.now;
        try {
            Date.now = () => realDateNow() + 61_000;

            // Second request — cache entry is expired → must fetch again
            await (service as any).handleHttpRequest({ ...baseRequest, requestId: "r2" });
            expect(fetchCallCount).toBe(2);
        } finally {
            Date.now = realDateNow;
        }
    });

    // ── Test 7 ────────────────────────────────────────────────────────────

    test("evicts oldest (LRU) entry when cache exceeds CACHE_MAX_SIZE", () => {
        const service = new TunnelService();
        const cache: Map<string, unknown> = (service as any).responseCache;

        // Fill exactly 100 entries (CACHE_MAX_SIZE)
        for (let i = 0; i < 100; i++) {
            (service as any).cacheSet(`key:${i}`, {
                status: 200,
                headers: {},
                body: Buffer.from(`body-${i}`).toString("base64"),
            });
        }

        expect(cache.size).toBe(100);
        // key:0 is the LRU (inserted first, never promoted)
        expect(cache.has("key:0")).toBe(true);

        // Insert entry 101 — must evict the LRU (key:0)
        (service as any).cacheSet("key:100", {
            status: 200,
            headers: {},
            body: Buffer.from("body-100").toString("base64"),
        });

        expect(cache.size).toBe(100);
        expect(cache.has("key:0")).toBe(false);   // evicted
        expect(cache.has("key:1")).toBe(true);    // still present
        expect(cache.has("key:99")).toBe(true);   // still present
        expect(cache.has("key:100")).toBe(true);  // newly inserted
    });
});
