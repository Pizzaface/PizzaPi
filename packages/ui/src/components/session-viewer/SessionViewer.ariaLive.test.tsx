/**
 * Regression test: an unrelated lifecycle dep change (e.g. agentActive
 * flipping) must not wipe a just-set ARIA live announcement before a screen
 * reader gets a chance to read it. The effect that derives the assertive /
 * polite sr-only region text must only ever SET a region on a real
 * announcement, never clear it back to "" on every run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

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
(globalThis as any).File = win.File;
(globalThis as any).FileReader = win.FileReader;
(globalThis as any).FormData = win.FormData;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as any).IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as any).requestAnimationFrame = () => 0;
(globalThis as any).cancelAnimationFrame = () => {};
/* eslint-enable @typescript-eslint/no-explicit-any */

const { act, cleanup, render } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { SessionViewer } = await import("../SessionViewer");

afterEach(cleanup);

function renderViewer(props: Record<string, unknown>) {
  return render(
    React.createElement(
      TooltipProvider,
      {},
      React.createElement(SessionViewer, {
        sessionId: "sess-1",
        messages: [],
        ...props,
      } as any),
    ),
  );
}

function regionText(container: HTMLElement, live: "assertive" | "polite") {
  return container.querySelector(`[aria-live="${live}"]`)?.textContent ?? "";
}

describe("SessionViewer ARIA live announcements", () => {
  test("a pending assertive announcement survives an unrelated agentActive dep change", async () => {
    const { container, rerender } = renderViewer({
      viewerStatus: "Connected",
      viewerDisconnected: false,
      agentActive: false,
    });
    expect(regionText(container, "assertive")).toBe("");

    // A real disconnect sets the assertive region.
    await act(async () => {
      rerender(
        React.createElement(
          TooltipProvider,
          {},
          React.createElement(SessionViewer, {
            sessionId: "sess-1",
            messages: [],
            viewerStatus: "Disconnected",
            viewerDisconnected: true,
            agentActive: false,
          } as any),
        ),
      );
    });
    expect(regionText(container, "assertive")).toContain("Disconnected");

    // An unrelated dep (agentActive) flips while still disconnected and the
    // status string is unchanged — must NOT wipe the pending announcement.
    await act(async () => {
      rerender(
        React.createElement(
          TooltipProvider,
          {},
          React.createElement(SessionViewer, {
            sessionId: "sess-1",
            messages: [],
            viewerStatus: "Disconnected",
            viewerDisconnected: true,
            agentActive: true,
          } as any),
        ),
      );
    });
    expect(regionText(container, "assertive")).toContain("Disconnected");
  });
});
