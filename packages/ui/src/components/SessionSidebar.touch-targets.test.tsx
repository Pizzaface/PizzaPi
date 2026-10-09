import * as React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(win as any).TypeError = globalThis.TypeError;

// Radix's Dialog (used by the multi-select confirm dialog below) dispatches
// CustomEvents onto this happy-dom document, so CustomEvent/Event must come
// from the SAME happy-dom realm as `win`, or happy-dom's EventTarget throws
// on its `instanceof Event` check. That conflicts with lib/ntfy-push.test.ts,
// which relies on bun's NATIVE CustomEvent/EventTarget pair — so these globals
// must be restored once this file's tests finish, not left clobbered for the
// rest of the test run.
const OVERRIDE_KEYS = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "NodeFilter", "SVGElement", "MutationObserver", "Event", "CustomEvent", "HTMLInputElement", "getComputedStyle"];
const originalGlobals = new Map(OVERRIDE_KEYS.map((key) => [key, (globalThis as any)[key]]));
for (const key of OVERRIDE_KEYS) {
    (globalThis as any)[key] = key === "window" ? win : (win as any)[key];
}
afterAll(() => {
    for (const [key, value] of originalGlobals) (globalThis as any)[key] = value;
});

const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
const { HubSocketContext } = await import("@/lib/hub-socket-context");
const { SessionSidebar } = await import("./SessionSidebar");

class FakeHubSocket {
    connected = false;
    private handlers = new Map<string, Set<(data?: unknown) => void>>();

    on(event: string, handler: (data?: unknown) => void) {
        const handlers = this.handlers.get(event) ?? new Set();
        handlers.add(handler);
        this.handlers.set(event, handlers);
        return this;
    }

    off(event: string, handler: (data?: unknown) => void) {
        this.handlers.get(event)?.delete(handler);
        return this;
    }

    emitServer(event: string, data?: unknown) {
        for (const handler of this.handlers.get(event) ?? []) handler(data);
    }
}

const session = (sessionId: string, parentSessionId: string | null = null) => ({
    sessionId,
    parentSessionId,
    shareUrl: `http://localhost/session/${sessionId}`,
    cwd: "/tmp/project",
    startedAt: "2026-01-01T00:00:00.000Z",
    isActive: true,
});

function renderSidebar(socket: FakeHubSocket, props: Partial<React.ComponentProps<typeof SessionSidebar>> = {}) {
    return render(
        <HubSocketContext.Provider value={socket as never}>
            <SessionSidebar
                onOpenSession={() => {}}
                onNewSession={() => {}}
                onClearSelection={() => {}}
                onShowRunners={() => {}}
                onShowSessions={() => {}}
                activeSessionId={null}
                showRunners={false}
                {...props}
            />
        </HubSocketContext.Provider>,
    );
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ pinnedSessions: [] })))) as typeof fetch;
});

afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
});

describe("SessionSidebar touch targets", () => {
    test("renders mobile action targets at least 44px tall/wide", async () => {
        const socket = new FakeHubSocket();
        const screen = renderSidebar(socket);

        await act(async () => {});
        act(() => {
            socket.emitServer("sessions", { sessions: [session("parent"), session("child", "parent")] });
        });

        for (const name of ["Select sessions", "New session"]) {
            const button = screen.getByRole("button", { name });
            // Desktop density is preserved — only touch devices get 44px.
            expect(button.className).toContain("h-9");
            expect(button.className).toContain("w-9");
            expect(button.className).toContain("md:h-8");
            expect(button.className).toContain("md:w-8");
            expect(button.className).toContain("pointer-coarse:min-h-11");
            expect(button.className).toContain("pointer-coarse:min-w-11");
        }

        for (const name of ["Sessions", "Runners"]) {
            expect(screen.getByRole("button", { name }).className).toContain("pointer-coarse:min-h-11");
        }

        const expandButton = screen.getByRole("button", { name: "Expand linked sessions" });
        // Chevron stays a small hit target on fine pointers, grows on touch.
        expect(expandButton.className).toContain("-m-1.5");
        expect(expandButton.className).toContain("p-1.5");
        expect(expandButton.className).toContain("pointer-coarse:h-11");
        expect(expandButton.className).toContain("pointer-coarse:w-11");
        expect(expandButton.className).not.toContain(" h-11");

        // Expand the linked-session group so the child becomes visible/selectable —
        // Select all only selects what's currently visible (#948), so a collapsed
        // child is otherwise excluded from the bulk-end count.
        fireEvent.click(expandButton);

        fireEvent.click(screen.getByRole("button", { name: "Select sessions" }));

        for (const name of ["Select all", "End selected sessions", "Cancel"]) {
            const button = await screen.findByRole("button", { name });
            expect(button.className).toContain("pointer-coarse:min-h-11");
            if (name !== "Cancel") expect(button.className).toContain("pointer-coarse:min-w-11");
        }

        fireEvent.click(screen.getByRole("button", { name: "Select all" }));
        fireEvent.click(screen.getByRole("button", { name: "End selected sessions" }));
        expect((await screen.findByRole("button", { name: "End 2 Sessions" })).className).toContain("min-h-11");
        expect(screen.getAllByRole("button", { name: "Cancel" }).at(-1)?.className).toContain("min-h-11");
        // The dialog cancel/confirm buttons grow unconditionally (overlays, not
        // density-sensitive desktop chrome) — confirmed above via "min-h-11".
    });

    test("renders mode and service launcher targets at least 44px", async () => {
        const socket = new FakeHubSocket();
        const screen = renderSidebar(socket, {
            selectedModeId: "work",
            sessionModes: [{ id: "work", label: "Work", icon: "folder-open", workspace: "/tmp/project" }],
            dynamicPanels: [
                { serviceId: "godmother", port: 1234, label: "Godmother", icon: "sparkles", launcher: { surface: "session-list", position: "bottom-left" } },
                { serviceId: "github", port: 1235, label: "GitHub", icon: "github", launcher: { surface: "session-list", position: "bottom-right" } },
            ],
        });

        await act(async () => {});

        expect(screen.getByRole("button", { name: "New in Work" }).className).toContain("pointer-coarse:min-h-11");
        for (const name of ["Godmother", "GitHub"]) {
            const button = screen.getByRole("button", { name });
            // These launchers render in the full-width (non-collapsed) footer —
            // desktop size is preserved, touch devices still get 44px.
            expect(button.className).toContain("h-8");
            expect(button.className).toContain("w-8");
            expect(button.className).toContain("pointer-coarse:min-h-11");
            expect(button.className).toContain("pointer-coarse:min-w-11");
        }
    });

    test("collapsed rail restores desktop density and avoids overflowing the w-12 rail on touch", async () => {
        const socket = new FakeHubSocket();
        const screen = renderSidebar(socket, {
            dynamicPanels: [
                { serviceId: "godmother", port: 1234, label: "Godmother", icon: "sparkles", launcher: { surface: "session-list", position: "bottom-left" } },
            ],
        });

        await act(async () => {});
        fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

        const expandButton = await screen.findByRole("button", { name: "Expand sidebar" });
        // The collapsed rail is hidden md:flex (desktop-only by display), so its
        // controls must not grow on fine pointers — only on touch, and the w-12
        // rail must still fit a 44px button at that point.
        expect(expandButton.className).toContain("h-9");
        expect(expandButton.className).toContain("w-9");
        expect(expandButton.className).toContain("md:h-8");
        expect(expandButton.className).toContain("md:w-8");
        expect(expandButton.className).toContain("pointer-coarse:min-h-11");
        expect(expandButton.className).toContain("pointer-coarse:min-w-11");

        const runnersButton = screen.getByRole("button", { name: "Runners" });
        expect(runnersButton.className).toContain("h-8");
        expect(runnersButton.className).toContain("w-8");
        expect(runnersButton.className).toContain("pointer-coarse:min-h-11");
        expect(runnersButton.className).toContain("pointer-coarse:min-w-11");

        const launcherButton = screen.getByRole("button", { name: "Godmother" });
        expect(launcherButton.className).toContain("h-8");
        expect(launcherButton.className).toContain("w-8");
        expect(launcherButton.className).toContain("pointer-coarse:min-h-11");
        expect(launcherButton.className).toContain("pointer-coarse:min-w-11");

        // The footer wrapper's px-1 (4px/side) leaves only 39px for a 44px
        // button inside the 47px-wide rail content box — drop the padding on
        // touch so the enlarged button actually fits.
        const footerWrapper = launcherButton.closest("div.border-t");
        expect(footerWrapper?.className).toContain("px-1");
        expect(footerWrapper?.className).toContain("pointer-coarse:px-0");
    });
});
