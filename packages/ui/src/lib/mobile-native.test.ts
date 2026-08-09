import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { Capacitor } from "@capacitor/core";
import * as realLocalNotifications from "@capacitor/local-notifications";
import * as realBadge from "@capawesome/capacitor-badge";

/**
 * Tests for the native bridge.
 *
 * We avoid mocking `@capacitor/core` (Bun's `mock.module` is process-global and
 * would leak into ntfy-push tests). Instead we monkeypatch the real `Capacitor`
 * platform methods in beforeEach and restore them in afterEach.
 *
 * The plugin modules (`@capacitor/local-notifications`, `@capawesome/capacitor-badge`)
 * are proxied objects that ignore per-method monkeypatching, so those still use
 * `mock.module`. They don't affect ntfy-push, and we restore them in afterAll.
 */

const origLocalStorage = (globalThis as any).localStorage;
const origGetPlatform = Capacitor.getPlatform;
const origIsNativePlatform = Capacitor.isNativePlatform;

/* eslint-disable @typescript-eslint/no-explicit-any */
const pluginCalls = {
    requestPermissions: 0,
    badgeRequestPermissions: 0,
    badgeSet: 0,
    badgeClear: 0,
};

mock.module("@capacitor/local-notifications", () => ({
    LocalNotifications: {
        requestPermissions: () => {
            pluginCalls.requestPermissions++;
            return Promise.resolve({ display: "granted" });
        },
    },
}));

mock.module("@capawesome/capacitor-badge", () => ({
    Badge: {
        requestPermissions: () => {
            pluginCalls.badgeRequestPermissions++;
            return Promise.resolve({ display: "granted" });
        },
        set: () => {
            pluginCalls.badgeSet++;
            return Promise.resolve();
        },
        clear: () => {
            pluginCalls.badgeClear++;
            return Promise.resolve();
        },
    },
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

afterAll(() => {
    // Restore the real plugin modules so other test files see the real plugins.
    mock.module("@capacitor/local-notifications", () => realLocalNotifications);
    mock.module("@capawesome/capacitor-badge", () => realBadge);
    (globalThis as any).localStorage = origLocalStorage;
});

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

function resetPluginCalls() {
    pluginCalls.requestPermissions = 0;
    pluginCalls.badgeRequestPermissions = 0;
    pluginCalls.badgeSet = 0;
    pluginCalls.badgeClear = 0;
}

function restorePlatform() {
    Capacitor.getPlatform = origGetPlatform;
    Capacitor.isNativePlatform = origIsNativePlatform;
    (globalThis as any).localStorage = origLocalStorage;
}

async function loadMobileNative(serverUrl: string | null, android: boolean) {
    Object.defineProperty(globalThis, "localStorage", {
        value: makeLocalStorage(serverUrl),
        configurable: true,
        writable: true,
    });
    if (android) {
        Capacitor.getPlatform = () => "android";
        Capacitor.isNativePlatform = () => true;
    } else {
        restorePlatform();
    }
    const mod = await import("./mobile-native");
    mod._resetMobileNativeState();
    return mod as typeof import("./mobile-native");
}

describe("mobile-native (web no-op path)", () => {
    let mod: typeof import("./mobile-native");

    beforeEach(async () => {
        resetPluginCalls();
        mod = await loadMobileNative(null, false);
    });

    afterEach(restorePlatform);

    test("requestNativePermissions resolves and does not touch plugins on web", async () => {
        await expect(mod.requestNativePermissions()).resolves.toBeUndefined();
        expect(pluginCalls.requestPermissions).toBe(0);
        expect(pluginCalls.badgeRequestPermissions).toBe(0);
    });

    test("setActivityBadge is a no-op for any count on web", async () => {
        await expect(mod.setActivityBadge(0)).resolves.toBeUndefined();
        await expect(mod.setActivityBadge(5)).resolves.toBeUndefined();
        await expect(mod.setActivityBadge(-3)).resolves.toBeUndefined();
        expect(pluginCalls.badgeSet).toBe(0);
        expect(pluginCalls.badgeClear).toBe(0);
    });
});

describe("mobile-native (android path)", () => {
    let mod: typeof import("./mobile-native");

    beforeEach(async () => {
        resetPluginCalls();
        mod = await loadMobileNative("https://relay.example.com", true);
    });

    afterEach(restorePlatform);

    test("requestNativePermissions requests both permissions once", async () => {
        await mod.requestNativePermissions();
        expect(pluginCalls.requestPermissions).toBe(1);
        expect(pluginCalls.badgeRequestPermissions).toBe(1);

        // Second call should be a no-op.
        await mod.requestNativePermissions();
        expect(pluginCalls.requestPermissions).toBe(1);
        expect(pluginCalls.badgeRequestPermissions).toBe(1);
    });

    test("setActivityBadge sets or clears based on count", async () => {
        await mod.setActivityBadge(3);
        expect(pluginCalls.badgeSet).toBe(1);
        expect(pluginCalls.badgeClear).toBe(0);
        await mod.setActivityBadge(0);
        expect(pluginCalls.badgeSet).toBe(1);
        expect(pluginCalls.badgeClear).toBe(1);
    });
});