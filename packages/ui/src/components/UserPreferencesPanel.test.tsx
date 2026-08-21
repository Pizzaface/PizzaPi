import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { type usePushState } from "./NotificationToggle";
import { NotificationsPreferencesSection } from "./UserPreferencesPanel";

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
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

let subscribed = false;
let native = false;
let suppressChild = true;
const toggleCalls: boolean[] = [];

function pushState(): ReturnType<typeof usePushState> {
    return {
        subscribed,
        loading: false,
        supported: true,
        native,
        permissionDenied: false,
        nativeUnconfigured: false,
        toggle: async () => {},
        suppressChild,
        suppressChildLoading: false,
        toggleSuppressChild: async () => {
            toggleCalls.push(!suppressChild);
            suppressChild = !suppressChild;
        },
    };
}

const hapticsState = () => ({ enabled: false, supported: false, toggle: () => {} });

function renderSection() {
    return render(
        <NotificationsPreferencesSection
            usePushStateHook={pushState}
            useHapticsStateHook={hapticsState}
        />,
    );
}

afterEach(() => {
    cleanup();
    subscribed = false;
    native = false;
    suppressChild = true;
    toggleCalls.length = 0;
});

describe("NotificationsPreferencesSection child suppression", () => {
    test("renders the preference for subscribed native users", () => {
        native = true;
        subscribed = true;

        const { container } = renderSection();

        expect(container.textContent).toContain("Suppress child session notifications");
    });

    test("renders the preference for subscribed web users", () => {
        subscribed = true;

        const { container } = renderSection();

        expect(container.textContent).toContain("Suppress child session notifications");
    });

    test("does not render the preference when native push is not subscribed", () => {
        native = true;

        const { container } = renderSection();

        expect(container.textContent).not.toContain("Suppress child session notifications");
    });

    test("reflects the default suppressed state and allows opting in", () => {
        native = true;
        subscribed = true;
        const { container } = renderSection();
        const switches = container.querySelectorAll("button[role='switch']");
        const suppressSwitch = switches[switches.length - 1];

        expect(suppressSwitch?.getAttribute("aria-checked")).toBe("true");
        fireEvent.click(suppressSwitch!);
        expect(toggleCalls).toEqual([false]);
    });
});
