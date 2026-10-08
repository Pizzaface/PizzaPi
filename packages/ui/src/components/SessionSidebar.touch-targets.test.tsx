import * as React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { HubSocketContext } from "@/lib/hub-socket-context";
import { SessionSidebar } from "./SessionSidebar";

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

function renderSidebar(socket: FakeHubSocket) {
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
            />
        </HubSocketContext.Provider>,
    );
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
    (globalThis.window as Window & typeof globalThis & { SyntaxError?: ErrorConstructor }).SyntaxError = globalThis.SyntaxError;
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ pinnedSessions: [] })))) as typeof fetch;
});

afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
});

describe("SessionSidebar touch targets", () => {
    test("renders mobile action targets at least 44px tall/wide", async () => {
        const socket = new FakeHubSocket();
        // Bind queries to this render: other suites replace happy-dom's document,
        // while Testing Library's global screen retains its import-time document.
        const screen = renderSidebar(socket);

        await act(async () => {});
        act(() => {
            socket.emitServer("sessions", { sessions: [session("parent"), session("child", "parent")] });
        });

        expect(screen.getByRole("button", { name: "Select sessions" })).toBeTruthy();

        for (const name of ["Select sessions", "New session"]) {
            const button = screen.getByRole("button", { name });
            expect(button.className).toContain("h-11");
            expect(button.className).toContain("w-11");
        }

        for (const name of ["Sessions", "Runners"]) {
            expect(screen.getByRole("button", { name }).className).toContain("min-h-11");
        }

        const expandButton = screen.getByRole("button", { name: "Expand linked sessions" });
        expect(expandButton.className).toContain("h-11");
        expect(expandButton.className).toContain("w-11");

        fireEvent.click(screen.getByRole("button", { name: "Select sessions" }));

        for (const name of ["Select all", "End selected sessions"]) {
            const button = await screen.findByRole("button", { name });
            expect(button.className).toContain("h-11");
            expect(button.className).toContain("w-11");
        }
        expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("h-11");
    });
});
