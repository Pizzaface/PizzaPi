import { afterAll, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import React from "react";

const { SessionSidebar } = await import("./SessionSidebar");
const { HubSocketContext } = await import("@/lib/hub-socket-context");

const originalMatchMedia = window.matchMedia;
const originalFetch = globalThis.fetch;
const originalSyntaxError = window.SyntaxError;
Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
// happy-dom v20 doesn't define this on the Window instance; production's
// querySelectorAll arrow-key path needs it when a selector is invalid.
window.SyntaxError = globalThis.SyntaxError;
globalThis.fetch = (async () => { throw new Error("no network in tests"); }) as typeof fetch;

afterAll(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
    window.SyntaxError = originalSyntaxError;
    globalThis.fetch = originalFetch;
});

function elementsWithAttr(root: Element, tag: string, attr: string, value?: string): HTMLElement[] {
    return Array.from(root.getElementsByTagName(tag))
        .filter((el) => el.hasAttribute(attr) && (value === undefined || el.getAttribute(attr) === value)) as HTMLElement[];
}

test("session rows expose actions and valid tree/keyboard semantics", async () => {
    const listeners = new Map<string, Set<(data: unknown) => void>>();
    const socket = {
        connected: false,
        on: (event: string, cb: (data: unknown) => void) => {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(cb);
        },
        off: (event: string, cb: (data: unknown) => void) => listeners.get(event)?.delete(cb),
    };
    const onOpenSession = mock(() => {});
    const { container } = render(
        <HubSocketContext.Provider value={socket as never}>
            <SessionSidebar onOpenSession={onOpenSession} onNewSession={() => {}}
                onClearSelection={() => {}} onShowRunners={() => {}} activeSessionId="child"
                onEndSession={() => {}} onDuplicateSession={() => {}} />
        </HubSocketContext.Provider>,
    );
    const sessions = [
        { sessionId: "parent", shareUrl: "https://example.test/p", cwd: "/work", startedAt: new Date().toISOString(), runnerId: "runner" },
        { sessionId: "child", shareUrl: "https://example.test/c", cwd: "/work", startedAt: new Date().toISOString(), runnerId: "runner", parentSessionId: "parent" },
    ];
    await act(async () => {
        for (const listener of listeners.get("sessions") ?? []) listener({ sessions });
    });

    expect(elementsWithAttr(container, "div", "role", "tree").length).toBe(1);
    const expand = elementsWithAttr(container, "button", "aria-label", "Expand linked sessions")[0];
    expect(expand).toBeDefined();
    let ancestor = expand.parentElement;
    while (ancestor && ancestor !== container) {
        expect(ancestor.tagName).not.toBe("BUTTON");
        ancestor = ancestor.parentElement;
    }
    // The chevron is a mouse-only affordance now: not a Tab stop, and the
    // expanded/collapsed state is announced once, on the treeitem.
    expect(expand.tabIndex).toBe(-1);
    expect(expand.hasAttribute("aria-expanded")).toBe(false);
    fireEvent.click(expand);

    const rows = elementsWithAttr(container, "div", "data-session-row");
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.getAttribute("role") === "treeitem")).toBe(true);
    expect(rows.map((row) => row.getAttribute("aria-level"))).toEqual(["1", "2"]);
    expect(rows[0].getAttribute("aria-expanded")).toBe("true");
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
    expect(rows.map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true"]);

    // Each row contributes exactly one Tab stop — the discoverable hover
    // actions (Duplicate/Pin/End) must not add any of their own.
    const duplicateButtons = elementsWithAttr(container, "button", "aria-label", "Duplicate session");
    const pinButtons = elementsWithAttr(container, "button", "aria-label", "Pin session");
    const endButtons = elementsWithAttr(container, "button", "aria-label", "End session");
    expect(duplicateButtons.length).toBe(2);
    expect(pinButtons.length).toBe(2);
    expect(endButtons.length).toBe(2);
    for (const btn of [...duplicateButtons, ...pinButtons, ...endButtons]) {
        expect(btn.tabIndex).toBe(-1);
        // Invisible-but-clickable is the bug: opacity alone still lets a tap
        // land on a hidden destructive button on touch devices with no hover.
        expect(btn.closest(".pointer-events-none")).not.toBeNull();
    }

    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    expect(rows[1].tabIndex).toBe(0);
    fireEvent.keyDown(rows[1], { key: "Enter" });
    expect(onOpenSession).toHaveBeenCalledWith("child");
});

test("ArrowRight/ArrowLeft expand, collapse, and move focus between parent/child rows", async () => {
    const listeners = new Map<string, Set<(data: unknown) => void>>();
    const socket = {
        connected: false,
        on: (event: string, cb: (data: unknown) => void) => {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(cb);
        },
        off: (event: string, cb: (data: unknown) => void) => listeners.get(event)?.delete(cb),
    };
    const { container } = render(
        <HubSocketContext.Provider value={socket as never}>
            <SessionSidebar onOpenSession={() => {}} onNewSession={() => {}}
                onClearSelection={() => {}} onShowRunners={() => {}} activeSessionId={null}
                onEndSession={() => {}} onDuplicateSession={() => {}} />
        </HubSocketContext.Provider>,
    );
    const sessions = [
        { sessionId: "parent", shareUrl: "https://example.test/p", cwd: "/work", startedAt: new Date().toISOString(), runnerId: "runner" },
        { sessionId: "child", shareUrl: "https://example.test/c", cwd: "/work", startedAt: new Date().toISOString(), runnerId: "runner", parentSessionId: "parent" },
    ];
    await act(async () => {
        for (const listener of listeners.get("sessions") ?? []) listener({ sessions });
    });

    const parentRow = elementsWithAttr(container, "div", "data-session-row")[0];
    expect(elementsWithAttr(container, "div", "data-session-row")).toHaveLength(1);
    parentRow.focus();

    // Collapsed parent: ArrowRight expands without moving focus.
    fireEvent.keyDown(parentRow, { key: "ArrowRight" });
    let rows = elementsWithAttr(container, "div", "data-session-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(parentRow);

    // Expanded parent: ArrowRight moves focus to the first child.
    fireEvent.keyDown(parentRow, { key: "ArrowRight" });
    rows = elementsWithAttr(container, "div", "data-session-row");
    expect(document.activeElement).toBe(rows[1]);

    // Leaf child: ArrowLeft moves focus back up to the parent.
    fireEvent.keyDown(rows[1], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(rows[0]);

    // Expanded parent: ArrowLeft collapses it (focus stays put).
    fireEvent.keyDown(rows[0], { key: "ArrowLeft" });
    rows = elementsWithAttr(container, "div", "data-session-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(rows[0]);
});
