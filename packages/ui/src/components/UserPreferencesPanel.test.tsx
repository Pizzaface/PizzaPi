/**
 * Tests for UserPreferencesPanel — native push child-suppression parity.
 *
 * Key invariant: The "Suppress child session notifications" toggle must render
 * on the Notifications tab when the user is subscribed AND native (the `!native`
 * guard in NotificationsPreferencesSection was removed by this PR).
 */

import { afterAll, afterEach, describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

// Set up DOM globals before any component imports.
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

// ── Controllable push state ─────────────────────────────────────────────────

let mockNative = false;
let mockSubscribed = false;
let mockSuppressChild = false;
const suppressToggleCalls: boolean[] = [];

const basePushState = () => ({
    subscribed: mockSubscribed,
    loading: false,
    supported: true,
    native: mockNative,
    permissionDenied: false,
    nativeUnconfigured: false,
    toggle: () => Promise.resolve(),
    suppressChild: mockSuppressChild,
    suppressChildLoading: false,
    toggleSuppressChild: async () => {
        suppressToggleCalls.push(!mockSuppressChild);
        mockSuppressChild = !mockSuppressChild;
    },
});

// Mock NotificationToggle to inject controlled state.
mock.module("./NotificationToggle", () => ({
    usePushState: basePushState,
    // Stub the rendered components (UserPreferencesPanel only uses usePushState from here).
    NotificationToggle: () => React.createElement("div", null, "NotificationToggle"),
    MobileNotificationMenuItem: () => null,
}));

// Mock HapticsToggle.
mock.module("./HapticsToggle", () => ({
    useHapticsState: () => ({ enabled: false, supported: false, toggle: () => {} }),
    HapticsToggle: () => null,
}));

// Mock AppearanceSettings (not under test here).
mock.module("./AppearanceSettings", () => ({
    AppearanceSettings: () => React.createElement("div", null, "AppearanceSettings"),
}));

mock.module("@pizzapi/tools", () => ({
    createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }),
}));

// Stub UI primitives that need Radix/Tailwind internals.
mock.module("@/components/ui/button", () => ({
    Button: ({ children, onClick, ...p }: any) =>
        React.createElement("button", { onClick, ...p }, children),
}));
mock.module("@/components/ui/switch", () => ({
    Switch: ({ checked, onCheckedChange, disabled }: any) =>
        React.createElement("input", {
            type: "checkbox",
            checked: !!checked,
            onChange: onCheckedChange ? () => onCheckedChange(!checked) : undefined,
            disabled: !!disabled,
            readOnly: !onCheckedChange,
        }),
}));
mock.module("@/components/ui/tooltip", () => ({
    Tooltip: ({ children }: any) => React.createElement("div", null, children),
    TooltipTrigger: ({ children, asChild }: any) => React.createElement("div", null, children),
    TooltipContent: ({ children }: any) => React.createElement("div", null, children),
}));
mock.module("lucide-react", () => ({
    X: () => React.createElement("span", null, "X"),
    Palette: () => React.createElement("span", null, "Palette"),
    Bell: () => React.createElement("span", null, "Bell"),
    Layers: () => React.createElement("span", null, "Layers"),
    EyeOff: () => React.createElement("span", null, "EyeOff"),
}));

const { UserPreferencesPanel } = await import("./UserPreferencesPanel");

afterAll(() => mock.restore());
afterEach(() => {
    cleanup();
    suppressToggleCalls.length = 0;
    mockSubscribed = false;
    mockNative = false;
    mockSuppressChild = false;
});

// ── Tests ────────────────────────────────────────────────────────────────────

function renderPanel() {
    return render(
        React.createElement(UserPreferencesPanel, {
            onClose: () => {},
            onShowHiddenModels: () => {},
            hiddenModelCount: 0,
        }),
    );
}

/** Click the Notifications tab so NotificationsPreferencesSection is visible. */
function clickNotificationsTab(container: HTMLElement) {
    const tabs = container.querySelectorAll("button");
    const notifTab = Array.from(tabs).find((b) => b.textContent?.includes("Notifications"));
    if (notifTab) fireEvent.click(notifTab);
}

describe("UserPreferencesPanel — suppress-child section (native parity)", () => {
    test("renders 'Suppress child session notifications' for native subscribed users", () => {
        mockNative = true;
        mockSubscribed = true;

        const { container } = renderPanel();
        clickNotificationsTab(container);

        expect(container.textContent).toContain("Suppress child session notifications");
    });

    test("renders 'Suppress child session notifications' for web subscribed users (regression guard)", () => {
        mockNative = false;
        mockSubscribed = true;

        const { container } = renderPanel();
        clickNotificationsTab(container);

        expect(container.textContent).toContain("Suppress child session notifications");
    });

    test("does NOT render suppress section when not subscribed (native)", () => {
        mockNative = true;
        mockSubscribed = false;

        const { container } = renderPanel();
        clickNotificationsTab(container);

        expect(container.textContent).not.toContain("Suppress child session notifications");
    });

    test("suppress switch reflects suppressChild state for native users", () => {
        mockNative = true;
        mockSubscribed = true;
        mockSuppressChild = true;

        const { container } = renderPanel();
        clickNotificationsTab(container);

        // Two checkboxes render: push-enabled (subscribed=true) and suppress-child.
        // The suppress-child one is the last checkbox in the section.
        const checkboxes = Array.from(container.querySelectorAll("input[type='checkbox']")) as HTMLInputElement[];
        expect(checkboxes.length).toBeGreaterThan(0);
        const suppressCheckbox = checkboxes[checkboxes.length - 1];
        expect(suppressCheckbox?.checked).toBe(true);
    });

    test("suppress switch is unchecked when suppressChild is false for native users", () => {
        mockNative = true;
        mockSubscribed = true;
        mockSuppressChild = false;

        const { container } = renderPanel();
        clickNotificationsTab(container);

        const checkboxes = Array.from(container.querySelectorAll("input[type='checkbox']")) as HTMLInputElement[];
        expect(checkboxes.length).toBeGreaterThan(0);
        const suppressCheckbox = checkboxes[checkboxes.length - 1];
        expect(suppressCheckbox?.checked).toBe(false);
    });
});
