import { afterEach, describe, expect, test } from "bun:test";
import {
    getTunnelHostConfig,
    matchTunnelHost,
    mintTunnelLabel,
    resolveTunnelLabel,
    handleTunnelHostRequest,
    _injectRedisForTesting,
} from "./tunnel-host";
import { proxyTunnelRequestViaRelay } from "./tunnel";

const ORIGINAL_DOMAIN = process.env.PIZZAPI_TUNNEL_DOMAIN;

afterEach(() => {
    if (ORIGINAL_DOMAIN === undefined) delete process.env.PIZZAPI_TUNNEL_DOMAIN;
    else process.env.PIZZAPI_TUNNEL_DOMAIN = ORIGINAL_DOMAIN;
    _injectRedisForTesting(null);
});

/** Minimal in-memory stand-in for the Redis client surface tunnel-host uses. */
function fakeRedis() {
    const store = new Map<string, string>();
    return {
        store,
        client: {
            set: async (key: string, value: string, _opts?: unknown) => { store.set(key, value); return "OK"; },
            get: async (key: string) => store.get(key) ?? null,
            expire: async (key: string) => store.has(key),
        } as never,
    };
}

describe("getTunnelHostConfig", () => {
    test("returns null when unset or empty", () => {
        delete process.env.PIZZAPI_TUNNEL_DOMAIN;
        expect(getTunnelHostConfig()).toBeNull();
        process.env.PIZZAPI_TUNNEL_DOMAIN = "   ";
        expect(getTunnelHostConfig()).toBeNull();
    });

    test("parses bare host, defaulting scheme by localhost-ness", () => {
        process.env.PIZZAPI_TUNNEL_DOMAIN = "t.localhost";
        expect(getTunnelHostConfig()).toEqual({ scheme: "http", host: "t.localhost", portSuffix: "" });
        process.env.PIZZAPI_TUNNEL_DOMAIN = "t.example.com";
        expect(getTunnelHostConfig()).toEqual({ scheme: "https", host: "t.example.com", portSuffix: "" });
    });

    test("parses explicit scheme and port", () => {
        process.env.PIZZAPI_TUNNEL_DOMAIN = "http://t.example.com:8443/";
        expect(getTunnelHostConfig()).toEqual({ scheme: "http", host: "t.example.com", portSuffix: ":8443" });
        process.env.PIZZAPI_TUNNEL_DOMAIN = "t.localhost:7492";
        expect(getTunnelHostConfig()).toEqual({ scheme: "http", host: "t.localhost", portSuffix: ":7492" });
    });
});

describe("matchTunnelHost", () => {
    const config = { scheme: "http" as const, host: "t.localhost", portSuffix: "" };
    const label = "a".repeat(32);

    test("extracts a direct subdomain label", () => {
        expect(matchTunnelHost(`${label}.t.localhost`, config)).toBe(label);
        expect(matchTunnelHost(`${label.toUpperCase()}.T.LOCALHOST`, config)).toBe(label);
    });

    test("rejects the bare apex, other domains, and multi-level subdomains", () => {
        expect(matchTunnelHost("t.localhost", config)).toBeNull();
        expect(matchTunnelHost("example.com", config)).toBeNull();
        expect(matchTunnelHost(`${label}.evil.t.localhost`, config)).toBeNull();
        expect(matchTunnelHost(`x.${label}.t.localhost`, config)).toBeNull();
    });

    test("rejects labels outside the minted shape", () => {
        expect(matchTunnelHost("short.t.localhost", config)).toBeNull();
        expect(matchTunnelHost(`${"A_".repeat(16)}.t.localhost`, config)).toBeNull();
        expect(matchTunnelHost(`.t.localhost`, config)).toBeNull();
    });

    test("returns null with no config", () => {
        delete process.env.PIZZAPI_TUNNEL_DOMAIN;
        expect(matchTunnelHost(`${label}.t.localhost`)).toBeNull();
    });
});

describe("mint + resolve labels", () => {
    test("mints a label and resolves the stored record, refreshing TTL", async () => {
        process.env.PIZZAPI_TUNNEL_DOMAIN = "t.localhost:7492";
        const { client } = fakeRedis();
        _injectRedisForTesting(client);

        const minted = await mintTunnelLabel({ userId: "u1", scope: "runner:r1", port: 3000 });
        expect(minted).not.toBeNull();
        expect(minted!.label).toMatch(/^[0-9a-f]{32}$/);
        expect(minted!.url).toBe(`http://${minted!.label}.t.localhost:7492/`);

        const record = await resolveTunnelLabel(minted!.label);
        expect(record).toEqual({ userId: "u1", scope: "runner:r1", port: 3000 });
    });

    test("returns null when unconfigured", async () => {
        delete process.env.PIZZAPI_TUNNEL_DOMAIN;
        const { client } = fakeRedis();
        _injectRedisForTesting(client);
        expect(await mintTunnelLabel({ userId: "u1", scope: "s1", port: 3000 })).toBeNull();
    });

    test("resolve rejects unknown labels and malformed records", async () => {
        process.env.PIZZAPI_TUNNEL_DOMAIN = "t.localhost";
        const { client, store } = fakeRedis();
        _injectRedisForTesting(client);
        expect(await resolveTunnelLabel("f".repeat(32))).toBeNull();
        store.set(`tunnel-host-label:${"e".repeat(32)}`, "{not json");
        expect(await resolveTunnelLabel("e".repeat(32))).toBeNull();
        store.set(`tunnel-host-label:${"d".repeat(32)}`, JSON.stringify({ userId: "", scope: "s", port: 1 }));
        expect(await resolveTunnelLabel("d".repeat(32))).toBeNull();
    });
});

describe("handleTunnelHostRequest", () => {
    test("returns undefined when unconfigured or hostname does not match", async () => {
        delete process.env.PIZZAPI_TUNNEL_DOMAIN;
        const req = new Request("http://abc.t.localhost/");
        expect(await handleTunnelHostRequest(req, new URL(req.url))).toBeUndefined();

        process.env.PIZZAPI_TUNNEL_DOMAIN = "t.localhost";
        const apex = new Request("http://t.localhost/");
        expect(await handleTunnelHostRequest(apex, new URL(apex.url))).toBeUndefined();
        const other = new Request("http://example.com/api/foo");
        expect(await handleTunnelHostRequest(other, new URL(other.url))).toBeUndefined();
    });

    test("404s an unknown label", async () => {
        process.env.PIZZAPI_TUNNEL_DOMAIN = "t.localhost";
        const { client } = fakeRedis();
        _injectRedisForTesting(client);
        const req = new Request(`http://${"a".repeat(32)}.t.localhost/some/path`);
        const res = await handleTunnelHostRequest(req, new URL(req.url));
        expect(res).toBeDefined();
        expect(res!.status).toBe(404);
    });

    test("rejects disallowed methods", async () => {
        process.env.PIZZAPI_TUNNEL_DOMAIN = "t.localhost";
        const req = new Request(`http://${"a".repeat(32)}.t.localhost/`, { method: "TRACE" });
        const res = await handleTunnelHostRequest(req, new URL(req.url));
        expect(res!.status).toBe(405);
    });
});

describe("passthrough proxy mode (basePath \"\")", () => {
    function runProxy(html: string, contentType: string, extraHeaders: Record<string, string> = {}) {
        let callbacks: {
            onResponseStart: (statusCode: number, statusMessage: string, headers: Record<string, string>) => void;
            onResponseData: (data: Buffer) => void;
            onResponseEnd: () => void;
            onError: (error: string) => void;
        } | undefined;

        const relay = {
            proxyHttpRequest: (_runnerId: string, _request: unknown, cb: NonNullable<typeof callbacks>) => {
                callbacks = cb;
                return { cancel() {} };
            },
            sendRequestDataEnd() {},
        };

        const responsePromise = proxyTunnelRequestViaRelay(
            new Request("http://abc.t.localhost/app/route"),
            relay as never,
            "runner-1",
            "req-1",
            "", // basePath "" → passthrough
            3000,
            "/app/route",
            "/app/route",
            {},
            true,
        );

        callbacks!.onResponseStart(200, "OK", { "content-type": contentType, ...extraHeaders });
        callbacks!.onResponseData(Buffer.from(html, "utf8"));
        callbacks!.onResponseEnd();
        return responsePromise;
    }

    test("streams HTML byte-identical — no base tag, no interceptor, no rewriting", async () => {
        const html = `<!doctype html><html><head><script src="/assets/app.js"></script></head>` +
            `<body><a href="/dashboard">go</a></body></html>`;
        const res = await runProxy(html, "text/html; charset=utf-8");
        const body = await res.text();
        expect(body).toBe(html);
        expect(body).not.toContain("<base");
        expect(body).not.toContain("data-pizzapi-tunnel-intercept");
    });

    test("streams JS and CSS untouched", async () => {
        const js = `import x from "/src/main.tsx"; import("/lazy.js");`;
        expect(await (await runProxy(js, "text/javascript")).text()).toBe(js);
        const css = `@import "/reset.css"; body { background: url(/bg.png); }`;
        expect(await (await runProxy(css, "text/css")).text()).toBe(css);
    });

    test("rewrites localhost Location headers to relative paths", async () => {
        const res = await runProxy("", "text/plain", { location: "http://127.0.0.1:3000/after-login?x=1" });
        expect(res.headers.get("location")).toBe("/after-login?x=1");
    });

    test("leaves root-relative Location headers untouched", async () => {
        const res = await runProxy("", "text/plain", { location: "/next" });
        expect(res.headers.get("location")).toBe("/next");
    });

    test("marks the response for cross-origin framing", async () => {
        const res = await runProxy("ok", "text/plain");
        expect(res.headers.get("x-pizzapi-tunnel")).toBe("1");
        expect(res.headers.get("x-pizzapi-tunnel-frame")).toBe("cross-origin");
    });
});
