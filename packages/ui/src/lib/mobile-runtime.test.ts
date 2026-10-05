import { describe, expect, test, beforeEach, afterEach } from "bun:test";

/**
 * Web no-op path for the mobile runtime. On web (no stored server URL, or not
 * a native platform) the secure-storage helpers must be safe no-ops and
 * `getMobileRuntimeConfig` must report isMobileBundled=false with no API key.
 */
import {
    getMobileRuntimeConfig,
    loadMobileApiKey,
    setMobileApiKey,
    clearMobileApiKey,
    initMobileRuntime,
    resolveMobileMediaUrlAsync,
    MobileMediaTokenError,
    _resetMobileRuntimeCache,
    _setMobileRuntimeCache,
} from "./mobile-runtime";

const origLocalStorage = (globalThis as any).localStorage;

function makeLocalStorage(serverUrl: string | null): Storage {
    const store: Record<string, string> = {};
    return {
        getItem: (key: string) => {
            if (key === "pizzapi.serverUrl") return serverUrl;
            return store[key] ?? null;
        },
        setItem: (key: string, value: string) => {
            store[key] = value;
        },
        removeItem: (key: string) => {
            delete store[key];
        },
        clear: () => {
            for (const key of Object.keys(store)) delete store[key];
        },
        key: (index: number) => Object.keys(store)[index] ?? null,
        length: 0,
    } as unknown as Storage;
}

describe("mobile-runtime (web no-op path)", () => {
    beforeEach(() => {
        _resetMobileRuntimeCache();
        Object.defineProperty(globalThis, "localStorage", {
            value: makeLocalStorage(null),
            configurable: true,
            writable: true,
        });
    });

    afterEach(() => {
        _resetMobileRuntimeCache();
        (globalThis as any).localStorage = origLocalStorage;
    });

    test("getMobileRuntimeConfig reports not mobile-bundled with no server URL", () => {
        const cfg = getMobileRuntimeConfig();
        expect(cfg.isMobileBundled).toBe(false);
        expect(cfg.serverUrl).toBeNull();
        expect(cfg.apiKey).toBeNull();
    });

    test("loadMobileApiKey is a no-op on web (does not throw, leaves cache null)", async () => {
        await expect(loadMobileApiKey()).resolves.toBeUndefined();
        expect(getMobileRuntimeConfig().apiKey).toBeNull();
    });

    test("setMobileApiKey / clearMobileApiKey are no-ops on web", async () => {
        await expect(setMobileApiKey("secret")).resolves.toBeUndefined();
        expect(getMobileRuntimeConfig().apiKey).toBeNull();
        await expect(clearMobileApiKey()).resolves.toBeUndefined();
        expect(getMobileRuntimeConfig().apiKey).toBeNull();
    });

    test("initMobileRuntime is a no-op on web", async () => {
        await expect(initMobileRuntime()).resolves.toBeUndefined();
        expect(getMobileRuntimeConfig().apiKey).toBeNull();
    });
});

describe("resolveMobileMediaUrlAsync (web no-op path)", () => {
    beforeEach(() => {
        _resetMobileRuntimeCache();
        Object.defineProperty(globalThis, "localStorage", {
            value: makeLocalStorage(null),
            configurable: true,
            writable: true,
        });
    });

    afterEach(() => {
        _resetMobileRuntimeCache();
        (globalThis as any).localStorage = origLocalStorage;
    });

    test("returns path unchanged on web", async () => {
        expect(await resolveMobileMediaUrlAsync("/api/attachments/abc")).toBe("/api/attachments/abc");
    });

    test("returns absolute URL unchanged on web", async () => {
        expect(await resolveMobileMediaUrlAsync("https://cdn.example.com/x.png")).toBe(
            "https://cdn.example.com/x.png",
        );
    });
});

describe("resolveMobileMediaUrlAsync (mobile-bundled path)", () => {
    const origFetch = globalThis.fetch;

    beforeEach(() => {
        _resetMobileRuntimeCache();
        _setMobileRuntimeCache("secret-key");
        Object.defineProperty(globalThis, "localStorage", {
            value: makeLocalStorage("https://relay.example.com"),
            configurable: true,
            writable: true,
        });
    });

    afterEach(() => {
        _resetMobileRuntimeCache();
        (globalThis as any).localStorage = origLocalStorage;
        globalThis.fetch = origFetch;
    });

    test("mints a token and appends ?token= for attachment URLs", async () => {
        (globalThis as any).fetch = async (_url: string, _opts?: RequestInit) =>
            new Response(JSON.stringify({ token: "tok-123" }), { status: 200 });

        const result = await resolveMobileMediaUrlAsync("/api/attachments/abc");
        expect(result).toContain("?token=tok-123");
        expect(result).toContain("https://relay.example.com");
    });

    test("rejects (never puts the API key in the URL) when the token fetch throws", async () => {
        (globalThis as any).fetch = async () => { throw new Error("network error"); };

        const err = await resolveMobileMediaUrlAsync("/api/attachments/abc").catch((e) => e);
        expect(err).toBeInstanceOf(MobileMediaTokenError);
        expect(String(err)).not.toContain("secret-key");
    });

    test("rejects when the token endpoint returns a non-OK status", async () => {
        (globalThis as any).fetch = async () => new Response("Unauthorized", { status: 401 });

        await expect(resolveMobileMediaUrlAsync("/api/attachments/abc")).rejects.toBeInstanceOf(MobileMediaTokenError);
    });

    test("rejects when the token endpoint returns no token", async () => {
        (globalThis as any).fetch = async () => new Response(JSON.stringify({}), { status: 200 });

        await expect(resolveMobileMediaUrlAsync("/api/attachments/abc")).rejects.toBeInstanceOf(MobileMediaTokenError);
    });

    test("strips any pre-existing ?apiKey= from attachment URLs", async () => {
        (globalThis as any).fetch = async () => new Response(JSON.stringify({ token: "tok-1" }), { status: 200 });

        const result = await resolveMobileMediaUrlAsync("/api/attachments/abc?apiKey=leaked");
        expect(result).not.toContain("apiKey");
        expect(result).toContain("token=tok-1");
    });

    test("resolves non-attachment relative paths against the server without a credential", async () => {
        // Non-attachment paths don't hit the token endpoint
        const fetchCalls: string[] = [];
        (globalThis as any).fetch = async (url: string) => { fetchCalls.push(url); throw new Error("should not be called"); };

        const result = await resolveMobileMediaUrlAsync("/api/sessions/x");
        expect(result).toBe("https://relay.example.com/api/sessions/x");
        expect(result).not.toContain("apiKey");
        expect(fetchCalls.length).toBe(0);
    });
});