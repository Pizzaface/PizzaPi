import { beforeEach, describe, expect, test } from "bun:test";
import {
    HOST_UNAVAILABLE_TTL_MS,
    HOST_URL_CACHE_TTL_MS,
    TUNNEL_IFRAME_SANDBOX,
    _resetHostTunnelCache,
    cacheHostTunnelUrl,
    describeTunnelFrame,
    getCachedHostTunnelUrl,
    hostTunnelsKnownUnavailable,
    isUsableHostTunnelUrl,
    markHostTunnelsUnavailable,
    tunnelCacheKey,
} from "./tunnel-frame";

describe("describeTunnelFrame", () => {
    const app = "https://pizza.example.com";

    test("path-prefix tunnel on the UI origin is not isolated", () => {
        expect(describeTunnelFrame("/api/tunnel/runner/r1/3000/", app)).toEqual({ sandbox: TUNNEL_IFRAME_SANDBOX, isolated: false });
        expect(describeTunnelFrame("https://pizza.example.com/api/tunnel/s/3000/", app).isolated).toBe(false);
    });

    test("dedicated tunnel origin is isolated", () => {
        expect(describeTunnelFrame("https://0123456789abcdef0123456789abcdef.t.example.net/", app).isolated).toBe(true);
    });

    test("different port or scheme counts as a different origin", () => {
        expect(describeTunnelFrame("https://pizza.example.com:8444/", app).isolated).toBe(true);
        expect(describeTunnelFrame("http://pizza.example.com/", app).isolated).toBe(true);
    });

    test("mobile: relay token URL is cross-origin to the Capacitor bundle", () => {
        expect(describeTunnelFrame("https://relay.example.com/api/tunnel/auth/tok/s/3000/", "https://localhost").isolated).toBe(true);
    });

    test("non-http(s) or unparseable src is never reported isolated", () => {
        expect(describeTunnelFrame("javascript:alert(1)", app).isolated).toBe(false);
        expect(describeTunnelFrame("http://[bad", app).isolated).toBe(false);
    });

    test("sandbox never grants top navigation or sandbox escape", () => {
        const { sandbox } = describeTunnelFrame("/x", app);
        expect(sandbox).not.toContain("allow-top-navigation");
        expect(sandbox).not.toContain("allow-popups-to-escape-sandbox");
    });
});

describe("isUsableHostTunnelUrl", () => {
    test("web on localhost can use *.localhost tunnel origins", () => {
        expect(isUsableHostTunnelUrl("http://abc.t.localhost:7492/", { appUrl: "http://localhost:7492/", mobile: false })).toBe(true);
    });

    test("web from another machine cannot use *.localhost tunnel origins", () => {
        expect(isUsableHostTunnelUrl("http://abc.t.localhost:7492/", { appUrl: "http://192.168.1.5:7492/", mobile: false })).toBe(false);
    });

    test("https UI cannot frame an http tunnel origin (mixed content)", () => {
        expect(isUsableHostTunnelUrl("http://abc.t.example.net/", { appUrl: "https://pizza.example.com/", mobile: false })).toBe(false);
        expect(isUsableHostTunnelUrl("https://abc.t.example.net/", { appUrl: "https://pizza.example.com/", mobile: false })).toBe(true);
    });

    test("mobile requires https and a non-localhost name", () => {
        expect(isUsableHostTunnelUrl("https://abc.t.example.net/", { appUrl: "https://localhost/", mobile: true })).toBe(true);
        expect(isUsableHostTunnelUrl("http://abc.t.example.net/", { appUrl: "https://localhost/", mobile: true })).toBe(false);
        expect(isUsableHostTunnelUrl("https://abc.t.localhost/", { appUrl: "https://localhost/", mobile: true })).toBe(false);
    });

    test("garbage is rejected", () => {
        expect(isUsableHostTunnelUrl("not a url", { appUrl: "http://localhost/", mobile: false })).toBe(false);
        expect(isUsableHostTunnelUrl("ftp://abc.t.example.net/", { appUrl: "http://localhost/", mobile: false })).toBe(false);
    });
});

describe("host tunnel URL cache", () => {
    beforeEach(() => _resetHostTunnelCache());

    test("keys are scoped by runner vs session and port", () => {
        expect(tunnelCacheKey({ runnerId: "r1", sessionId: "s1", port: 3000 })).toBe("runner:r1:3000");
        expect(tunnelCacheKey({ sessionId: "s1", port: 3000 })).toBe("session:s1:3000");
        expect(tunnelCacheKey({ sessionId: "s1", port: 3001 })).not.toBe(tunnelCacheKey({ sessionId: "s1", port: 3000 }));
    });

    test("cached URLs expire after the TTL", () => {
        cacheHostTunnelUrl("k", "https://a.t.example.net/", 1000);
        expect(getCachedHostTunnelUrl("k", 1000 + HOST_URL_CACHE_TTL_MS - 1)).toBe("https://a.t.example.net/");
        expect(getCachedHostTunnelUrl("k", 1000 + HOST_URL_CACHE_TTL_MS)).toBeNull();
        expect(getCachedHostTunnelUrl("k", 1000)).toBeNull(); // evicted
    });

    test("unavailability is remembered for a while, cleared by a successful mint", () => {
        markHostTunnelsUnavailable(0);
        expect(hostTunnelsKnownUnavailable(HOST_UNAVAILABLE_TTL_MS - 1)).toBe(true);
        expect(hostTunnelsKnownUnavailable(HOST_UNAVAILABLE_TTL_MS)).toBe(false);
        markHostTunnelsUnavailable(0);
        cacheHostTunnelUrl("k", "https://a.t.example.net/", 1);
        expect(hostTunnelsKnownUnavailable(2)).toBe(false);
    });
});
