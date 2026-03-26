/**
 * Tests for TunnelPanel — specifically the stale-state fix:
 *   when `available` transitions false the component must clear `tunnels` and
 *   `previewPort` so that on the next reconnect no stale entries flash.
 */
import { afterAll, afterEach, describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import { render, act, cleanup } from "@testing-library/react";
import React from "react";

// ── DOM globals ─────────────────────────────────────────────────────────────
// Must be set BEFORE any component/hook imports so that React, lucide-react,
// etc. see a DOM at module-evaluation time.
const win = new Window({ url: "http://localhost/" });
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
// ResizeObserver stub — guards against transitive deps that use it
(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Shared mock state ────────────────────────────────────────────────────────
// The mock reads `channelState.available` on every render so tests can drive
// it by mutating the object and calling `rerender`.
const channelState = {
    available: false,
};

const sendSpy = mock((_type: string, _payload: unknown) => {});

// Capture the `onMessage` callback TunnelPanel passes to useServiceChannel
// so individual tests can simulate incoming server messages.
let capturedOnMessage:
    | ((type: string, payload: unknown, requestId?: string) => void)
    | undefined;

mock.module("@/hooks/useServiceChannel", () => ({
    useServiceChannel: (
        _serviceId: string,
        opts: { onMessage?: (type: string, payload: unknown, requestId?: string) => void } = {}
    ) => {
        capturedOnMessage = opts.onMessage;
        return { send: sendSpy, available: channelState.available };
    },
    // Re-export the pure helper so indirect imports still resolve
    getEagerServiceAvailability: () => false,
}));

// Restore all module mocks after this file so they don't bleed into other
// test files running in the same Bun worker process.
afterAll(() => mock.restore());

// Import AFTER mock is registered
const { TunnelPanel } = await import("./TunnelPanel");

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeTunnel(port: number) {
    return { port, url: `/api/tunnel/sess/${port}/`, pinned: false };
}

/** Returns all <iframe> elements inside a container without using querySelector. */
function getIframes(container: HTMLElement): HTMLCollectionOf<HTMLIFrameElement> {
    return container.getElementsByTagName("iframe") as HTMLCollectionOf<HTMLIFrameElement>;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    sendSpy.mockClear();
    capturedOnMessage = undefined;
    channelState.available = false;
});

// ── Tests ────────────────────────────────────────────────────────────────────
describe("TunnelPanel — stale tunnel state fix", () => {
    test("sends tunnel_list when available becomes true", async () => {
        channelState.available = true;

        await act(async () => {
            render(<TunnelPanel sessionId="sess" />);
        });

        expect(sendSpy).toHaveBeenCalledWith("tunnel_list", {});
    });

    test("does not call send('tunnel_list') when available is false", async () => {
        channelState.available = false;

        await act(async () => {
            render(<TunnelPanel sessionId="sess" />);
        });

        // Component returns null when unavailable — effect must not request the list
        const sentTunnelList = sendSpy.mock.calls.some(([type]) => type === "tunnel_list");
        expect(sentTunnelList).toBe(false);
    });

    test("clears stale tunnels on disconnect — no flash on reconnect", async () => {
        // ① Start connected — component is visible
        channelState.available = true;
        let container!: HTMLElement;
        let rerender!: (ui: React.ReactElement) => void;

        await act(async () => {
            ({ container, rerender } = render(<TunnelPanel sessionId="sess" />));
        });

        // ② Server responds with one tunnel (port 3000)
        await act(async () => {
            capturedOnMessage?.("tunnel_list_result", {
                tunnels: [makeTunnel(3000)],
            });
        });

        // Tunnel tab must be visible
        expect(container.textContent).toContain("3000");

        // ③ Disconnect — component returns null AND must clear internal state
        channelState.available = false;
        await act(async () => {
            rerender(<TunnelPanel sessionId="sess" />);
        });

        // Component renders nothing when unavailable
        expect(container.textContent).not.toContain("3000");

        // ④ Reconnect — without the fix, stale port 3000 would flash here
        channelState.available = true;
        sendSpy.mockClear();
        await act(async () => {
            rerender(<TunnelPanel sessionId="sess" />);
        });

        // A fresh tunnel_list request should be sent again
        expect(sendSpy).toHaveBeenCalledWith("tunnel_list", {});

        // Crucially: port 3000 must NOT appear before a new tunnel_list_result
        // arrives — proving the state was cleared on disconnect, not carried over.
        expect(container.textContent).not.toContain("3000");
    });

    test("clears previewPort on disconnect (no stale iframe after reconnect)", async () => {
        // ① Connect and populate a tunnel — previewPort will auto-set to 4000
        channelState.available = true;
        let container!: HTMLElement;
        let rerender!: (ui: React.ReactElement) => void;

        await act(async () => {
            ({ container, rerender } = render(<TunnelPanel sessionId="sess" />));
        });

        await act(async () => {
            capturedOnMessage?.("tunnel_list_result", {
                tunnels: [makeTunnel(4000)],
            });
        });

        // An <iframe> should be rendered for the auto-previewed tunnel
        expect(getIframes(container).length).toBe(1);

        // ② Disconnect
        channelState.available = false;
        await act(async () => {
            rerender(<TunnelPanel sessionId="sess" />);
        });

        // ③ Reconnect — iframe must NOT appear until a new response arrives
        channelState.available = true;
        await act(async () => {
            rerender(<TunnelPanel sessionId="sess" />);
        });

        // previewPort was cleared on disconnect, so no iframe yet
        expect(getIframes(container).length).toBe(0);
    });
});
