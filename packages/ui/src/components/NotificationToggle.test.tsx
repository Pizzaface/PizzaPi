/**
 * Tests for native push child-suppression parity in NotificationToggle.
 *
 * Key invariants verified:
 *  1. usePushState.toggleSuppressChild routes to setNativeSuppressChildNotifications
 *     for native users (not setSuppressChildNotifications).
 *  2. usePushState.toggleSuppressChild routes to setSuppressChildNotifications
 *     for web push users.
 *  3. After toggle, suppressChild state reflects the new value.
 */

import { afterAll, afterEach, describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import { renderHook, act, cleanup } from "@testing-library/react";
import React from "react"; // needed so JSX transform is happy when components pull it in

// Set up DOM globals BEFORE importing the component.
const win = new Window({ url: "http://localhost/" });
/* eslint-disable @typescript-eslint/no-explicit-any */
(win as any).SyntaxError = SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).KeyboardEvent = win.KeyboardEvent;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).CustomEvent = win.CustomEvent;
(globalThis as any).ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
};
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Controllable mock state ──────────────────────────────────────────────────
// Variables captured by mock closures (set per-test via beforeEach/test body).

let isNativeAvailable = true;
let hasPermission = true;
let isDisabled = false;
let startResult: { ok: boolean; reason?: string } = { ok: true };
let nativeSuppressValue = false;
let webSuppressValue = false;

const nativeSetCalls: boolean[] = [];
const webSetCalls: boolean[] = [];

mock.module("@/lib/ntfy-push", () => ({
    isNativePushAvailable: () => isNativeAvailable,
    hasNativePushPermission: () => Promise.resolve(hasPermission),
    isNativePushDisabled: () => isDisabled,
    setNativePushDisabled: () => {},
    requestNativePushPermission: () => Promise.resolve(true),
    startNtfyPush: () => Promise.resolve(startResult),
    stopNtfyPush: () => Promise.resolve(),
    getNativeSuppressChildNotifications: () => nativeSuppressValue,
    setNativeSuppressChildNotifications: (suppress: boolean) => {
        nativeSetCalls.push(suppress);
        nativeSuppressValue = suppress;
        return Promise.resolve(true);
    },
}));

mock.module("@/lib/push", () => ({
    isPushSupported: () => !isNativeAvailable,
    isPushSubscribed: () => Promise.resolve(!isNativeAvailable),
    getNotificationPermission: () => "granted",
    // Return the current tracked value so refreshState() gets the up-to-date preference
    // when the pp-push-state-changed event triggers a re-read.
    getSuppressChildNotifications: () => Promise.resolve(webSuppressValue),
    setSuppressChildNotifications: (suppress: boolean) => {
        webSetCalls.push(suppress);
        webSuppressValue = suppress;
        return Promise.resolve(true);
    },
    subscribeToPush: () => Promise.resolve(null),
    unsubscribeFromPush: () => Promise.resolve(false),
}));

mock.module("@pizzapi/tools", () => ({
    createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }),
}));

// Stub heavy UI components so they don't blow up without a full Radix/Tailwind env.
mock.module("@/components/ui/button", () => ({
    Button: ({ children, ...p }: any) => React.createElement("button", p, children),
}));
mock.module("@/components/ui/switch", () => ({
    Switch: (p: any) => React.createElement("input", { type: "checkbox", ...p }),
}));
mock.module("@/components/ui/tooltip", () => ({
    TooltipProvider: ({ children }: any) => children,
    Tooltip: ({ children }: any) => children,
    TooltipTrigger: ({ children }: any) => children,
    TooltipContent: ({ children }: any) => React.createElement("div", null, children),
}));
mock.module("@/components/ui/dropdown-menu", () => ({
    DropdownMenu: ({ children }: any) => React.createElement("div", null, children),
    DropdownMenuTrigger: ({ children }: any) => React.createElement("div", null, children),
    DropdownMenuContent: ({ children }: any) => React.createElement("div", null, children),
    DropdownMenuLabel: ({ children }: any) => React.createElement("div", null, children),
    DropdownMenuSeparator: () => React.createElement("hr"),
    DropdownMenuItem: ({ children, onSelect, disabled }: any) =>
        React.createElement("div", { onClick: onSelect, "aria-disabled": disabled }, children),
}));

const { usePushState } = await import("./NotificationToggle");

afterAll(() => mock.restore());
afterEach(() => {
    cleanup();
    nativeSetCalls.length = 0;
    webSetCalls.length = 0;
    nativeSuppressValue = false;
    webSuppressValue = false;
    isNativeAvailable = true;
    hasPermission = true;
    isDisabled = false;
    startResult = { ok: true };
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("usePushState — native child-suppression routing", () => {
    test("toggleSuppressChild calls setNativeSuppressChildNotifications for native users", async () => {
        isNativeAvailable = true;
        hasPermission = true;
        isDisabled = false;
        startResult = { ok: true };
        nativeSuppressValue = false;

        const { result } = renderHook(() => usePushState());

        // Wait for async refreshState to complete (hasNativePushPermission + startNtfyPush).
        await act(async () => {
            await new Promise((r) => setTimeout(r, 20));
        });

        expect(result.current.subscribed).toBe(true);
        expect(result.current.native).toBe(true);
        expect(result.current.suppressChild).toBe(false);

        await act(async () => {
            await result.current.toggleSuppressChild();
        });

        // Must have called the NATIVE api, not the web one.
        expect(nativeSetCalls).toEqual([true]);
        expect(webSetCalls).toEqual([]);
        expect(result.current.suppressChild).toBe(true);
    });

    test("toggleSuppressChild calls setSuppressChildNotifications for web push users", async () => {
        isNativeAvailable = false; // web push path
        hasPermission = false;     // irrelevant for web
        isDisabled = false;
        startResult = { ok: false, reason: "error" };
        nativeSuppressValue = false;
        webSuppressValue = false;

        const { result } = renderHook(() => usePushState());

        // Wait for async isPushSubscribed (which we mock to return true when !native).
        await act(async () => {
            await new Promise((r) => setTimeout(r, 20));
        });

        // Web path: subscribed from isPushSubscribed mock (returns !isNativeAvailable = true).
        expect(result.current.native).toBe(false);
        expect(result.current.subscribed).toBe(true);

        await act(async () => {
            await result.current.toggleSuppressChild();
        });

        // Must have called the WEB api, not the native one.
        expect(webSetCalls).toEqual([true]);
        expect(nativeSetCalls).toEqual([]);
        expect(result.current.suppressChild).toBe(true);
    });

    test("toggleSuppressChild toggles back to false for native", async () => {
        isNativeAvailable = true;
        hasPermission = true;
        isDisabled = false;
        startResult = { ok: true };
        nativeSuppressValue = true; // start as suppressed

        const { result } = renderHook(() => usePushState());
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

        expect(result.current.suppressChild).toBe(true);

        await act(async () => { await result.current.toggleSuppressChild(); });

        expect(nativeSetCalls).toEqual([false]);
        expect(result.current.suppressChild).toBe(false);
    });
});
