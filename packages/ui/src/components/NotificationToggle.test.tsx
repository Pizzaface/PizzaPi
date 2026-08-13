/**
 * Tests for NotificationToggle's native (Android/ntfy) subscribed state.
 *
 * The bug this guards against: `startNtfyPush()` used to swallow every
 * failure (503 unconfigured, fetch error, malformed response) and the toggle
 * derived `subscribed` purely from OS permission + a localStorage flag — so a
 * user could see "Notifications enabled" with zero server registration.
 *
 * We avoid `mock.module("@/lib/ntfy-push", ...)` / `mock.module("./ntfy-push", ...)`
 * on purpose: Bun's `mock.module` keys off the resolved file, so mocking it
 * here would leak into ntfy-push.test.ts (run in the same process per the
 * project's test command) and stub out the real function this test exists to
 * exercise. Instead we monkeypatch `Capacitor` platform methods directly
 * (same technique as mobile-native.test.ts) and control `fetch` per test.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Capacitor } from "@capacitor/core";
import * as realLocalNotifications from "@capacitor/local-notifications";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).getComputedStyle = () => ({
    getPropertyValue: () => "",
    paddingRight: "",
    paddingTop: "",
    paddingLeft: "",
    paddingBottom: "",
});
(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};
(globalThis as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const origGetPlatform = Capacitor.getPlatform;
const origIsNativePlatform = Capacitor.isNativePlatform;
const origLocalStorage = (globalThis as any).localStorage;

// Permission check/request always report "granted" — these tests are about
// what happens to `subscribed` *after* permission is already granted.
let permissionCalls = 0;
mock.module("@capacitor/local-notifications", () => ({
    LocalNotifications: {
        checkPermissions: () => {
            permissionCalls++;
            return Promise.resolve({ display: "granted" });
        },
        requestPermissions: () => {
            permissionCalls++;
            return Promise.resolve({ display: "granted" });
        },
    },
}));

afterAll(() => {
    // Restore the real plugin module so other test files see the real plugin.
    mock.module("@capacitor/local-notifications", () => realLocalNotifications);
    Capacitor.getPlatform = origGetPlatform;
    Capacitor.isNativePlatform = origIsNativePlatform;
    (globalThis as any).localStorage = origLocalStorage;
});

function makeLocalStorage(serverUrl: string | null): Storage {
    const store: Record<string, string> = {};
    return {
        getItem: (key: string) => (key === "pizzapi.serverUrl" ? serverUrl : (store[key] ?? null)),
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

function goAndroidNative() {
    Object.defineProperty(globalThis, "localStorage", {
        value: makeLocalStorage("https://relay.example.com"),
        configurable: true,
        writable: true,
    });
    Capacitor.getPlatform = () => "android";
    Capacitor.isNativePlatform = () => true;
}

const { NotificationToggle } = await import("./NotificationToggle");

beforeEach(() => {
    permissionCalls = 0;
    goAndroidNative();
});

afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
});

function ariaLabel(container: HTMLElement): string | null {
    return container.querySelector("button[aria-label]")?.getAttribute("aria-label") ?? null;
}

describe("NotificationToggle (native/ntfy registration outcome)", () => {
    test("503 (ntfy unconfigured) surfaces as unconfigured, not subscribed", async () => {
        (globalThis as any).fetch = mock(async () => ({ ok: false, status: 503 }) as Response);

        let container!: HTMLElement;
        await act(async () => {
            ({ container } = render(<NotificationToggle />));
        });

        await waitFor(() => expect(ariaLabel(container)).not.toBe("Loading…"));
        expect(ariaLabel(container)).toBe("Push not configured on this server");
        // Not-subscribed path renders a plain button, no dropdown trigger.
        expect(container.querySelector("[aria-haspopup]")).toBeNull();
    });

    test("successful registration surfaces as subscribed", async () => {
        (globalThis as any).fetch = mock(async () => ({
            ok: true,
            json: async () => ({ ntfyPublicUrl: "https://ntfy.example.com", topic: "pizzapi-abc123" }),
        }) as Response);

        let container!: HTMLElement;
        await act(async () => {
            ({ container } = render(<NotificationToggle />));
        });

        await waitFor(() => expect(ariaLabel(container)).not.toBe("Loading…"));
        expect(ariaLabel(container)).toBe("Notifications enabled");
    });

    test("fetch throw surfaces as not subscribed (generic, not unconfigured)", async () => {
        (globalThis as any).fetch = mock(async () => {
            throw new Error("network down");
        });

        let container!: HTMLElement;
        await act(async () => {
            ({ container } = render(<NotificationToggle />));
        });

        await waitFor(() => expect(ariaLabel(container)).not.toBe("Loading…"));
        expect(ariaLabel(container)).toBe("Enable notifications");
    });
});
