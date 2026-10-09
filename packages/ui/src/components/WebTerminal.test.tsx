/**
 * Regression test for GM VD0KKFpB (959-r4 REDESIGN): WebTerminal must never
 * emit kill_terminal on its own — the server is now authoritative for
 * killing a session's terminals on confirmed session end (see
 * sio-registry/sessions.ts endSharedSession). The UI only prunes its own tab
 * bookkeeping (usePanelLayout.terminal-pruning.test.ts); WebTerminal itself
 * must stay silent through mount/unmount and only emit kill_terminal for the
 * unrelated, legitimate user-driven "close this terminal" action.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type * as React from "react";
import { Window } from "happy-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";

// ── DOM globals ─────────────────────────────────────────────────────────────
const win = new Window({ url: "http://localhost/" });
/* eslint-disable @typescript-eslint/no-explicit-any */
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).HTMLInputElement = win.HTMLInputElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).Event = win.Event;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as any).matchMedia = () => ({ matches: false });
(globalThis as any).localStorage = win.localStorage;
(globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
/* eslint-enable @typescript-eslint/no-explicit-any */

// xterm.js needs a real canvas renderer — stub the whole surface instead of
// fighting it in happy-dom.
mock.module("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    textarea = null;
    open() {}
    loadAddon() {}
    write() {}
    writeln() {}
    dispose() {}
    focus() {}
    onData() { return { dispose() {} }; }
  },
}));
mock.module("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() { return { cols: 80, rows: 24 }; }
  },
}));
mock.module("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));

// Fake Socket.IO client — tracks every emitted event so tests can assert
// kill_terminal is (or isn't) among them.
const emittedEvents: Array<{ event: string; data: unknown }> = [];
function makeFakeSocket() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const socket = {
    connected: true,
    on(event: string, cb: (...args: unknown[]) => void) {
      (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(cb);
      return socket;
    },
    once(event: string, cb: (...args: unknown[]) => void) {
      return socket.on(event, cb);
    },
    off() { return socket; },
    emit(event: string, data?: unknown) {
      emittedEvents.push({ event, data });
      return socket;
    },
    disconnect() { socket.connected = false; },
  };
  return socket;
}
let lastSocket: ReturnType<typeof makeFakeSocket> | null = null;
mock.module("socket.io-client", () => ({
  io: mock(() => { lastSocket = makeFakeSocket(); return lastSocket; }),
}));

afterEach(() => {
  cleanup();
  emittedEvents.length = 0;
  lastSocket = null;
});

const { WebTerminal } = await import("./WebTerminal");
const { ThemeProvider } = await import("./ThemeProvider");
const { TooltipProvider } = await import("./ui/tooltip");

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider><TooltipProvider>{ui}</TooltipProvider></ThemeProvider>);
}

describe("WebTerminal — never self-initiates kill_terminal", () => {
  test("mounting and unmounting (simulating a pruned tab) emits no kill_terminal", () => {
    const { unmount } = renderWithTheme(<WebTerminal terminalId="term-1" />);
    expect(emittedEvents.some((e) => e.event === "kill_terminal")).toBe(false);

    // This is exactly what usePanelLayout's confirmed-end pruning does now:
    // just unmount the tab. It must not send kill_terminal — the server
    // already killed the PTY on confirmed session end.
    unmount();
    expect(emittedEvents.some((e) => e.event === "kill_terminal")).toBe(false);
  });

  test("clicking the close button still emits kill_terminal (unrelated, user-driven close)", () => {
    const onClose = mock(() => {});
    const { getByLabelText } = renderWithTheme(<WebTerminal terminalId="term-1" onClose={onClose} />);

    fireEvent.click(getByLabelText("Close terminal"));

    expect(emittedEvents.some((e) => e.event === "kill_terminal" && (e.data as { terminalId: string }).terminalId === "term-1")).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });
});
