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
    _resetMobileRuntimeCache,
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