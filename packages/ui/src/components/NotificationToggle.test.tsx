import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import {
    NotificationToggle,
    usePushState,
    type PushDependencies,
} from "./NotificationToggle";

const originalCustomEvent = globalThis.CustomEvent;
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
(globalThis as any).CustomEvent = win.CustomEvent;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
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

let native = true;
let nativeSuppress = true;
let webSuppress = false;
let startResult: Awaited<ReturnType<PushDependencies["startNtfyPush"]>> = { ok: true };
const nativeSetCalls: boolean[] = [];
const webSetCalls: boolean[] = [];

const dependencies: PushDependencies = {
    isPushSupported: () => !native,
    isPushSubscribed: async () => !native,
    subscribeToPush: async () => null,
    unsubscribeFromPush: async () => false,
    getNotificationPermission: () => "granted",
    getSuppressChildNotifications: async () => webSuppress,
    setSuppressChildNotifications: async (suppress) => {
        webSetCalls.push(suppress);
        webSuppress = suppress;
        return true;
    },
    isNativePushAvailable: () => native,
    isNativePushDisabled: () => false,
    setNativePushDisabled: () => {},
    hasNativePushPermission: async () => true,
    requestNativePushPermission: async () => true,
    startNtfyPush: async () => startResult,
    stopNtfyPush: async () => {},
    getNativeSuppressChildNotifications: () => nativeSuppress,
    setNativeSuppressChildNotifications: async (suppress) => {
        nativeSetCalls.push(suppress);
        nativeSuppress = suppress;
        return true;
    },
};

beforeEach(() => {
    native = true;
    nativeSuppress = true;
    webSuppress = false;
    startResult = { ok: true };
    nativeSetCalls.length = 0;
    webSetCalls.length = 0;
});

afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
});

afterAll(() => {
    (globalThis as any).CustomEvent = originalCustomEvent;
});

async function waitForHook() {
    const hook = renderHook(() => usePushState(dependencies));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    return hook;
}

function ariaLabel(container: HTMLElement): string | null {
    return container.querySelector("button[aria-label]")?.getAttribute("aria-label") ?? null;
}

describe("usePushState child-suppression routing", () => {
    test("routes native preferences to the native API", async () => {
        nativeSuppress = false;
        const { result } = await waitForHook();

        await act(async () => result.current.toggleSuppressChild());

        expect(nativeSetCalls).toEqual([true]);
        expect(webSetCalls).toEqual([]);
        expect(result.current.suppressChild).toBe(true);
    });

    test("routes web preferences to the Web Push API", async () => {
        native = false;
        const { result } = await waitForHook();

        await act(async () => result.current.toggleSuppressChild());

        expect(webSetCalls).toEqual([true]);
        expect(nativeSetCalls).toEqual([]);
        expect(result.current.suppressChild).toBe(true);
    });

    test("can opt in to child notifications for native push", async () => {
        const { result } = await waitForHook();
        expect(result.current.suppressChild).toBe(true);

        await act(async () => result.current.toggleSuppressChild());

        expect(nativeSetCalls).toEqual([false]);
        expect(result.current.suppressChild).toBe(false);
    });
});

describe("NotificationToggle native registration outcome", () => {
    test("shows ntfy configuration failures instead of subscribed", async () => {
        startResult = { ok: false, reason: "unconfigured" };
        const { container } = render(<NotificationToggle dependencies={dependencies} />);

        await waitFor(() => expect(ariaLabel(container)).toBe("Push not configured on this server"));
        expect(container.querySelector("[aria-haspopup]")).toBeNull();
    });

    test("shows generic registration failures as not subscribed", async () => {
        startResult = { ok: false, reason: "error" };
        const { container } = render(<NotificationToggle dependencies={dependencies} />);

        await waitFor(() => expect(ariaLabel(container)).toBe("Enable notifications"));
    });

    test("shows a successful registration as subscribed", async () => {
        const { container } = render(<NotificationToggle dependencies={dependencies} />);

        await waitFor(() => expect(ariaLabel(container)).toBe("Notifications enabled"));
    });
});
