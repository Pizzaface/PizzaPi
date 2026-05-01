import { afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import React from "react";

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
(globalThis as any).KeyboardEvent = win.KeyboardEvent;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
/* eslint-enable @typescript-eslint/no-explicit-any */

const mentionEntries = [
  { name: "alpha.ts", path: "alpha.ts", isDirectory: false },
  { name: "beta.ts", path: "beta.ts", isDirectory: false },
];

mock.module("@/hooks/useAtMentionFiles", () => ({
  useAtMentionFiles: () => ({
    entries: mentionEntries,
    loading: false,
    error: null,
  }),
}));

mock.module("@/hooks/useAtMentionSearch", () => ({
  useAtMentionSearch: () => ({ entries: [], loading: false, error: null }),
}));

const { AtMentionPopover } = await import("./AtMentionPopover");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  mock.restore();
});

describe("AtMentionPopover keyboard navigation", () => {
  test("document ArrowDown moves between options and scrolls the highlighted option into view", async () => {
    const scrollIntoView = mock(() => {});
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView as unknown as typeof HTMLElement.prototype.scrollIntoView;

    try {
      const highlighted: number[] = [];
      const { container } = render(
        <AtMentionPopover
          open
          runnerId="runner-1"
          path=""
          query=""
          onSelectFile={() => {}}
          onDrillInto={() => {}}
          onClose={() => {}}
          onHighlightedIndexChange={(index) => highlighted.push(index)}
        />,
      );

      await waitFor(() => {
        expect(container.querySelectorAll("[role='option']").length).toBe(2);
        expect(container.querySelector("[role='option'][aria-selected='true']")?.textContent).toContain("alpha.ts");
      });

      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      });

      await waitFor(() => {
        expect(container.querySelector("[role='option'][aria-selected='true']")?.textContent).toContain("beta.ts");
        expect(highlighted.at(-1)).toBe(1);
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });
});
