import { describe, expect, test } from "bun:test";
import {
    hardenPathTunnelResponseHeaders,
    rejectCrossSiteTunnelRequest,
    scopePathTunnelSetCookie,
} from "./tunnel-isolation";
import { handleTunnelRoute, proxyTunnelRequestViaRelay } from "./tunnel";

const TRUSTED = ["https://pizza.example.com", "http://localhost:7492"];

function req(headers: Record<string, string>, url = "https://pizza.example.com/api/tunnel/runner/r1/3000/"): Request {
    return new Request(url, { headers });
}

describe("rejectCrossSiteTunnelRequest", () => {
    test("allows requests without a cookie (API key / scripts)", () => {
        expect(rejectCrossSiteTunnelRequest(req({ "sec-fetch-site": "cross-site" }), TRUSTED)).toBeNull();
    });

    test("allows same-origin, none, and missing Sec-Fetch-Site", () => {
        expect(rejectCrossSiteTunnelRequest(req({ cookie: "a=1", "sec-fetch-site": "same-origin" }), TRUSTED)).toBeNull();
        expect(rejectCrossSiteTunnelRequest(req({ cookie: "a=1", "sec-fetch-site": "none" }), TRUSTED)).toBeNull();
        expect(rejectCrossSiteTunnelRequest(req({ cookie: "a=1" }), TRUSTED)).toBeNull();
    });

    test("rejects cross-site entry (e.g. a host-tunnel page navigating onto the relay)", async () => {
        const res = rejectCrossSiteTunnelRequest(
            req({ cookie: "a=1", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }),
            TRUSTED,
        );
        expect(res?.status).toBe(403);
        expect(((await res!.json()) as { error: string }).error).toContain("PIZZAPI_TUNNEL_DOMAIN");
    });

    test("rejects same-site entry from an untrusted origin (*.localhost tunnel vs localhost relay)", () => {
        const res = rejectCrossSiteTunnelRequest(
            req({ cookie: "a=1", "sec-fetch-site": "same-site", referer: "http://abc123.t.localhost:7492/" }),
            TRUSTED,
        );
        expect(res?.status).toBe(403);
        // No initiator info at all (Referrer-Policy: no-referrer) → reject too.
        expect(rejectCrossSiteTunnelRequest(req({ cookie: "a=1", "sec-fetch-site": "same-site" }), TRUSTED)?.status).toBe(403);
    });

    test("allows same-site entry from a trusted relay origin", () => {
        expect(rejectCrossSiteTunnelRequest(
            req({ cookie: "a=1", "sec-fetch-site": "same-site", origin: "http://localhost:7492" }),
            TRUSTED,
        )).toBeNull();
        expect(rejectCrossSiteTunnelRequest(
            req({ cookie: "a=1", "sec-fetch-site": "same-site", referer: "https://pizza.example.com/some/page" }),
            () => TRUSTED,
        )).toBeNull();
    });

    test("does not resolve trusted origins unless needed", () => {
        let called = false;
        const lazy = () => { called = true; return TRUSTED; };
        rejectCrossSiteTunnelRequest(req({ cookie: "a=1", "sec-fetch-site": "cross-site" }), lazy);
        rejectCrossSiteTunnelRequest(req({ cookie: "a=1", "sec-fetch-site": "same-origin" }), lazy);
        expect(called).toBe(false);
    });
});

describe("handleTunnelRoute cross-site gate", () => {
    // The gate runs before auth, so no auth context is required here.
    test("session path tunnel rejects cross-site navigation with 403", async () => {
        const res = await handleTunnelRoute(
            req({ cookie: "better-auth.session_token=x", "sec-fetch-site": "cross-site" }, "https://pizza.example.com/api/tunnel/s-1/3000/"),
            new URL("https://pizza.example.com/api/tunnel/s-1/3000/"),
        );
        expect(res?.status).toBe(403);
    });

    test("runner path tunnel rejects cross-site navigation with 403", async () => {
        const url = "https://pizza.example.com/api/tunnel/runner/r1/3000/evil.html";
        const res = await handleTunnelRoute(
            req({ cookie: "better-auth.session_token=x", "sec-fetch-site": "cross-site" }, url),
            new URL(url),
        );
        expect(res?.status).toBe(403);
    });
});

describe("scopePathTunnelSetCookie", () => {
    const base = "/api/tunnel/runner/r1/3000";

    test("pins Path to the tunnel prefix and strips Domain", () => {
        expect(scopePathTunnelSetCookie("sid=abc; Path=/; Domain=.example.com; HttpOnly; SameSite=Lax", base))
            .toBe(`sid=abc; HttpOnly; SameSite=Lax; Path=${base}`);
    });

    test("adds Path when the app omitted it", () => {
        expect(scopePathTunnelSetCookie("theme=dark", base)).toBe(`theme=dark; Path=${base}`);
    });

    test("normalises a trailing slash on the base path", () => {
        expect(scopePathTunnelSetCookie("a=1", `${base}/`)).toBe(`a=1; Path=${base}`);
    });

    test("drops __Host- cookies and relay auth cookie names", () => {
        expect(scopePathTunnelSetCookie("__Host-sid=1; Path=/; Secure", base)).toBeNull();
        expect(scopePathTunnelSetCookie("better-auth.session_token=evil; Path=/", base)).toBeNull();
        expect(scopePathTunnelSetCookie("__Secure-better-auth.session_token=evil; Secure", base)).toBeNull();
        expect(scopePathTunnelSetCookie("=novalue", base)).toBeNull();
    });

    test("keeps __Secure- cookies that are not relay auth cookies", () => {
        expect(scopePathTunnelSetCookie("__Secure-x=1; Secure", base)).toBe(`__Secure-x=1; Secure; Path=${base}`);
    });
});

describe("hardenPathTunnelResponseHeaders", () => {
    test("drops origin-wide headers and rescopes every Set-Cookie", () => {
        const headers = new Headers();
        headers.set("service-worker-allowed", "/");
        headers.set("clear-site-data", "\"*\"");
        headers.set("content-type", "text/html");
        headers.append("set-cookie", "a=1; Path=/");
        headers.append("set-cookie", "better-auth.session_token=evil; Path=/");
        headers.append("set-cookie", "b=2; Domain=example.com");

        hardenPathTunnelResponseHeaders(headers, "/api/tunnel/s-1/3000");

        expect(headers.get("service-worker-allowed")).toBeNull();
        expect(headers.get("clear-site-data")).toBeNull();
        expect(headers.get("content-type")).toBe("text/html");
        expect(headers.getSetCookie()).toEqual([
            "a=1; Path=/api/tunnel/s-1/3000",
            "b=2; Path=/api/tunnel/s-1/3000",
        ]);
    });
});

describe("proxyTunnelRequestViaRelay response isolation", () => {
    function relayResponding(headers: Record<string, string | string[]>, body = "ok") {
        return {
            proxyHttpRequest: (_runnerId: string, _request: unknown, cb: {
                onResponseStart: (code: number, statusMessage: string, headers: Record<string, string | string[]>) => void;
                onResponseData: (chunk: Buffer) => void;
                onResponseEnd: () => void;
            }) => {
                setTimeout(() => {
                    cb.onResponseStart(200, "OK", headers);
                    cb.onResponseData(Buffer.from(body));
                    cb.onResponseEnd();
                }, 0);
                return { cancel() {} };
            },
            sendRequestDataEnd() {},
        };
    }

    const upstream = {
        "content-type": "text/plain",
        "service-worker-allowed": "/",
        "set-cookie": ["a=1; Path=/", "better-auth.session_token=evil; Path=/"],
    };

    test("path-prefix tunnels scope cookies and strip Service-Worker-Allowed", async () => {
        const res = await proxyTunnelRequestViaRelay(
            new Request("http://localhost/api/tunnel/s-1/3000/"),
            relayResponding(upstream) as never,
            "runner-1", "req-1", "/api/tunnel/s-1/3000", 3000, "/", "/", {},
        );
        expect(res.headers.get("service-worker-allowed")).toBeNull();
        expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/api/tunnel/s-1/3000"]);
    });

    test("host tunnels (dedicated origin) keep the app's own headers", async () => {
        const res = await proxyTunnelRequestViaRelay(
            new Request("http://abc.t.localhost/"),
            relayResponding(upstream) as never,
            "runner-1", "req-2", "", 3000, "/", "/", {}, true,
        );
        expect(res.headers.get("service-worker-allowed")).toBe("/");
        expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "better-auth.session_token=evil; Path=/"]);
    });
});
