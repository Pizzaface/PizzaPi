/**
 * Regression test for gm-0MUWQPwh: queued-message Edit/Remove/Send-now
 * buttons were hidden behind `opacity-0 group-hover:opacity-100` with no
 * focus/touch fallback, so they were unreachable on touch devices (no
 * hover state) and via keyboard-only navigation.
 *
 * The wrapper must reveal on `group-focus-within` for keyboards and on
 * `hover:none` devices for touch screens.
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

const { cleanup, render } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { SessionViewer } = await import("../SessionViewer");

afterEach(cleanup);

describe("SessionViewer queued message actions (touch/keyboard reachability)", () => {
  test("edit/remove/send-now buttons reveal via focus-within and touch fallback, not just hover", () => {
    const view = render(
      React.createElement(
        TooltipProvider,
        {},
        React.createElement(SessionViewer, {
          sessionId: "sess-1",
          messages: [],
          viewerStatus: "Connected",
          messageQueue: [
            { id: "qm-1", text: "do the thing", deliverAs: "followUp", timestamp: Date.now() },
          ],
          onEditQueuedMessage: () => {},
          onRemoveQueuedMessage: () => {},
          onSendQueuedMessageNow: () => {},
        } as any),
      ),
    );

    const editButton = view.container.querySelector(
      'button[aria-label="Edit queued message"]',
    ) as HTMLButtonElement;
    expect(editButton).toBeTruthy();

    // The wrapper div around the action buttons is the one that controls
    // visibility via opacity; it must offer a non-hover reveal path.
    const actionsWrapper = editButton.parentElement as HTMLElement;
    expect(actionsWrapper.className).toContain("opacity-0");
    expect(actionsWrapper.className).toContain("group-hover:opacity-100");
    expect(actionsWrapper.className).toContain("group-focus-within:opacity-100");
    expect(actionsWrapper.className).toContain("[@media(hover:none)]:opacity-100");

    // Keyboard/touch users must actually be able to reach the button.
    editButton.focus();
    expect(win.document.activeElement).toBe(editButton);
  });
});
