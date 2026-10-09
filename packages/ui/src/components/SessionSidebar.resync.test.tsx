import { afterAll, afterEach, describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import { render, cleanup, waitFor } from "@testing-library/react";
import React from "react";

// Set up DOM globals BEFORE importing the component — see CombinedPanel.test.tsx
// for why this must happen before any transitive import touches react-dom.
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
(globalThis as any).localStorage = win.localStorage;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
/* eslint-enable @typescript-eslint/no-explicit-any */

mock.module("@/lib/utils", () => ({
  cn: (...classes: (string | undefined | null | false)[]) => classes.filter(Boolean).join(" "),
}));

mock.module("@pizzapi/tools", () => ({
  createLogger: () => ({
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
}));

const { SessionSidebar } = await import("./SessionSidebar");
const { HubSocketContext } = await import("@/lib/hub-socket-context");

afterAll(() => mock.restore());

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/** Minimal event-emitter stand-in for the shared hub socket.io-client instance. */
function makeMockHubSocket(connected: boolean) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    connected,
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(handler);
    },
  };
}

const noop = () => {};

describe("SessionSidebar already-connected resync", () => {
  test("fetches the session list immediately when the hub socket is already connected on mount", async () => {
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = mock((url: string) => {
      fetchCalls.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ sessions: [] }),
      } as Response);
    });

    try {
      const hubSocket = makeMockHubSocket(true);

      render(
        <HubSocketContext.Provider value={hubSocket as any}>
          <SessionSidebar
            onOpenSession={noop}
            onNewSession={noop}
            onClearSelection={noop}
            onShowRunners={noop}
            activeSessionId={null}
          />
        </HubSocketContext.Provider>,
      );

      // Regression guard: must NOT need to wait out the 1200ms delayed
      // fallback timer — the already-connected path already missed the
      // socket's initial "sessions" snapshot, so there is no later event to
      // fall back from. A broken version of this effect only schedules the
      // fallback timer and fetches nothing within this window.
      await waitFor(
        () => {
          expect(fetchCalls.some((url) => url.startsWith("/api/sessions?"))).toBe(true);
        },
        { timeout: 500 },
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});
