import { describe, expect, test } from "bun:test";

/**
 * Web no-op path for ntfy push. The plugin + helpers are gated on
 * `isMobileBundled && Capacitor.isNativePlatform() && platform === "android"`,
 * all false in the bun test env (no localStorage server URL, not native). So
 * every export must be a safe no-op here — guarding the PWA build against
 * accidentally invoking the native plugin.
 */
import {
    startNtfyPush,
    stopNtfyPush,
    isNativePushAvailable,
    isNativePushDisabled,
    setNativePushDisabled,
    hasNativePushPermission,
    requestNativePushPermission,
} from "./ntfy-push";

describe("ntfy-push (web no-op path)", () => {
    test("startNtfyPush is a no-op on web (does not throw, makes no network call)", async () => {
        let fetched = false;
        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = () => {
            fetched = true;
            return Promise.resolve(new Response("{}", { status: 200 }));
        };
        try {
            await expect(startNtfyPush()).resolves.toBeUndefined();
        } finally {
            (globalThis as any).fetch = origFetch;
        }
        expect(fetched).toBe(false);
    });

    test("stopNtfyPush is a no-op on web", async () => {
        let fetched = false;
        const origFetch = globalThis.fetch;
        (globalThis as any).fetch = () => {
            fetched = true;
            return Promise.resolve(new Response("{}", { status: 200 }));
        };
        try {
            await expect(stopNtfyPush()).resolves.toBeUndefined();
        } finally {
            (globalThis as any).fetch = origFetch;
        }
        expect(fetched).toBe(false);
    });

    test("both are idempotent across repeated calls", async () => {
        await startNtfyPush();
        await startNtfyPush();
        await stopNtfyPush();
        await stopNtfyPush();
        expect(true).toBe(true);
    });

    test("native helpers are safe no-ops on web", async () => {
        expect(isNativePushAvailable()).toBe(false);
        await expect(hasNativePushPermission()).resolves.toBe(false);
        await expect(requestNativePushPermission()).resolves.toBe(false);
    });

    test("disabled flag round-trips through localStorage", () => {
        // bun test has no localStorage — a Map-backed stub is enough.
        const store = new Map<string, string>();
        (globalThis as any).localStorage = {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        };
        expect(isNativePushDisabled()).toBe(false);
        setNativePushDisabled(true);
        expect(isNativePushDisabled()).toBe(true);
        setNativePushDisabled(false);
        expect(isNativePushDisabled()).toBe(false);
        delete (globalThis as any).localStorage;
    });
});