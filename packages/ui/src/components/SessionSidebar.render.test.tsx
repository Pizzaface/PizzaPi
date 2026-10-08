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

    expect(elementsWithAttr(container, "div", "role", "tree").length).toBe(1);
    const expand = elementsWithAttr(container, "button", "aria-label", "Expand linked sessions")[0];
    expect(expand).toBeDefined();
    let ancestor = expand.parentElement;
    while (ancestor && ancestor !== container) {
        expect(ancestor.tagName).not.toBe("BUTTON");
        ancestor = ancestor.parentElement;
    }
    fireEvent.click(expand);

    const rows = elementsWithAttr(container, "div", "data-session-row");
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.getAttribute("role") === "treeitem")).toBe(true);
    expect(rows.map((row) => row.getAttribute("aria-level"))).toEqual(["1", "2"]);
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
    expect(elementsWithAttr(container, "button", "aria-label", "Duplicate session").length).toBe(2);
    expect(elementsWithAttr(container, "button", "aria-label", "Pin session").length).toBe(2);
    expect(elementsWithAttr(container, "button", "aria-label", "End session").length).toBe(2);

    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    expect(rows[1].tabIndex).toBe(0);
    fireEvent.keyDown(rows[1], { key: "Enter" });
    expect(onOpenSession).toHaveBeenCalledWith("child");
});
