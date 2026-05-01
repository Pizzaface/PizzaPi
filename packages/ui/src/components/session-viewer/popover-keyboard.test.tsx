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
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
/* eslint-enable @typescript-eslint/no-explicit-any */

const { getNextPopoverIndex, useDocumentPopoverKeyboardNavigation } = await import("./popover-keyboard");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  mock.restore();
});

describe("popover keyboard navigation", () => {
  test("getNextPopoverIndex wraps ArrowDown and ArrowUp through available options", () => {
    expect(getNextPopoverIndex(0, 3, "ArrowDown")).toBe(1);
    expect(getNextPopoverIndex(2, 3, "ArrowDown")).toBe(0);
    expect(getNextPopoverIndex(0, 3, "ArrowUp")).toBe(2);
    expect(getNextPopoverIndex(1, 3, "ArrowUp")).toBe(0);
    expect(getNextPopoverIndex(0, 0, "ArrowDown")).toBeNull();
    expect(getNextPopoverIndex(0, 3, "Enter")).toBeNull();
  });

  test("document ArrowDown moves to the next option and scrolls the highlighted option into view", async () => {
    const scrollIntoView = mock(() => {});
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView as unknown as typeof HTMLElement.prototype.scrollIntoView;

    function Harness() {
      const [index, setIndex] = React.useState(0);
      useDocumentPopoverKeyboardNavigation({
        open: true,
        totalItems: 3,
        highlightedIndex: index,
        setHighlightedIndex: setIndex,
        popoverSelector: "[data-test-popover]",
      });
      return (
        <div data-test-popover="">
          {["one", "two", "three"].map((item, itemIndex) => (
            <div key={item} data-option="" data-selected={itemIndex === index ? "true" : "false"}>
              {item}
            </div>
          ))}
        </div>
      );
    }

    try {
      const { container } = render(<Harness />);
      expect(container.querySelector("[data-selected='true']")?.textContent).toBe("one");

      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      });

      await waitFor(() => {
        expect(container.querySelector("[data-selected='true']")?.textContent).toBe("two");
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });
});
