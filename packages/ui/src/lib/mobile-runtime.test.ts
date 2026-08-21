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
    resolveMobileMediaUrl,
    resolveMobileMediaUrlAsync,
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

    test("resolveMobileMediaUrl leaves relative paths untouched on web", () => {
        expect(resolveMobileMediaUrl("/api/attachments/abc")).toBe("/api/attachments/abc");
    });
});

describe("resolveMobileMediaUrl (mobile-bundled path)", () => {
    beforeEach(() => {
        _resetMobileRuntimeCache();
        Object.defineProperty(globalThis, "localStorage", {
            value: makeLocalStorage("https://relay.example.com"),
            configurable: true,
            writable: true,
        });
    });

    afterEach(() => {
        _resetMobileRuntimeCache();
        (globalThis as any).localStorage = origLocalStorage;
    });

    test("prepends server URL and appends API key for relative media paths", () => {
        _setMobileRuntimeCache("secret-key");
        expect(resolveMobileMediaUrl("/api/attachments/abc")).toBe(
            "https://relay.example.com/api/attachments/abc?apiKey=secret-key",
        );
    });

    test("prepends server URL without key when none is cached", () => {
        expect(resolveMobileMediaUrl("/api/attachments/abc")).toBe(
            "https://relay.example.com/api/attachments/abc",
        );
    });

    test("leaves absolute URLs untouched", () => {
        _setMobileRuntimeCache("secret-key");
        expect(resolveMobileMediaUrl("https://cdn.example.com/x.png")).toBe(
            "https://cdn.example.com/x.png",
        );
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

    test("falls back to deprecated ?apiKey= URL when token fetch fails", async () => {
        (globalThis as any).fetch = async () => { throw new Error("network error"); };

        const result = await resolveMobileMediaUrlAsync("/api/attachments/abc");
        // Fallback to resolveMobileMediaUrl which uses ?apiKey=
        expect(result).toContain("?apiKey=secret-key");
    });

    test("falls back when fetch returns non-OK status", async () => {
        (globalThis as any).fetch = async () => new Response("Unauthorized", { status: 401 });

        const result = await resolveMobileMediaUrlAsync("/api/attachments/abc");
        expect(result).toContain("?apiKey=secret-key");
    });

    test("returns non-attachment relative paths via deprecated path", async () => {
        // Non-attachment paths don't hit the token endpoint
        const fetchCalls: string[] = [];
        (globalThis as any).fetch = async (url: string) => { fetchCalls.push(url); throw new Error("should not be called"); };

        const result = await resolveMobileMediaUrlAsync("/api/sessions/x");
        // No attachment match → falls through to resolveMobileMediaUrl
        expect(result).toContain("https://relay.example.com/api/sessions/x");
        expect(fetchCalls.length).toBe(0);
    });
});