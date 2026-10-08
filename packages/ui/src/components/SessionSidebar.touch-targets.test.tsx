import * as React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(win as any).TypeError = globalThis.TypeError;
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "NodeFilter", "SVGElement", "MutationObserver", "Event", "CustomEvent", "HTMLInputElement", "getComputedStyle"]) {
    (globalThis as any)[key] = key === "window" ? win : (win as any)[key];
}

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
            expect(button.className).toContain("h-11");
            expect(button.className).toContain("w-11");
            expect(button.className).not.toContain("md:h-8");
        }

        for (const name of ["Sessions", "Runners"]) {
            expect(screen.getByRole("button", { name }).className).toContain("min-h-11");
        }

        const expandButton = screen.getByRole("button", { name: "Expand linked sessions" });
        expect(expandButton.className).toContain("h-11");
        expect(expandButton.className).toContain("w-11");

        fireEvent.click(screen.getByRole("button", { name: "Select sessions" }));

        for (const name of ["Select all", "End selected sessions", "Cancel"]) {
            const button = await screen.findByRole("button", { name });
            expect(button.className).toContain("h-11");
            if (name !== "Cancel") expect(button.className).toContain("w-11");
        }

        fireEvent.click(screen.getByRole("button", { name: "Select all" }));
        fireEvent.click(screen.getByRole("button", { name: "End selected sessions" }));
        expect((await screen.findByRole("button", { name: "End 2 Sessions" })).className).toContain("min-h-11");
        expect(screen.getAllByRole("button", { name: "Cancel" }).at(-1)?.className).toContain("min-h-11");
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

        expect(screen.getByRole("button", { name: "New in Work" }).className).toContain("min-h-11");
        for (const name of ["Godmother", "GitHub"]) {
            const button = screen.getByRole("button", { name });
            expect(button.className).toContain("h-11");
            expect(button.className).toContain("w-11");
        }
    });
});
