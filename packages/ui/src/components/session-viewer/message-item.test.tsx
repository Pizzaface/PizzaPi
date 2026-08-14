import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import React from "react";
import type { RelayMessage } from "./types";

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
(globalThis as any).ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
/* eslint-enable @typescript-eslint/no-explicit-any */

const { SessionMessageItem } = await import("./message-item");
const { SessionActionsProvider } = await import("./session-actions-context");

afterEach(() => cleanup());

describe("SessionMessageItem custom messages", () => {
  test("quotes selected assistant text through session actions", () => {
    const message: RelayMessage = {
      key: "assistant-quote",
      role: "assistant",
      timestamp: 1_700_000_000_000,
      content: "Select this sentence",
    };
    let quoted = "";
    const view = render(
      <SessionActionsProvider value={{ abort: () => {}, quote: (text) => { quoted = text; } }}>
        <SessionMessageItem message={message} isLast={false} />
      </SessionActionsProvider>,
    );
    const text = view.getByText("Select this sentence");
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    fireEvent.click(view.getByRole("button", { name: "Quote" }));

    expect(quoted).toBe("Select this sentence");
  });

  test("quotes text parts from an assistant message when nothing is selected", () => {
    const message: RelayMessage = {
      key: "assistant-quote-parts",
      role: "assistant",
      timestamp: 1_700_000_000_000,
      content: [
        { type: "text", text: "First part" },
        { type: "toolCall", toolName: "ignored" },
        { type: "text", text: " second part" },
        { type: "toolResult", result: "ignored" },
      ],
    };
    let quoted = "";
    window.getSelection()?.removeAllRanges();

    const view = render(
      <SessionActionsProvider value={{ abort: () => {}, quote: (text) => { quoted = text; } }}>
        <SessionMessageItem message={message} isLast={false} />
      </SessionActionsProvider>,
    );

    fireEvent.click(view.getByRole("button", { name: "Quote" }));

    expect(quoted).not.toContain("## 🤖 Assistant");
    expect(quoted).toContain("First part second part");
  });

  test("shows the full custom message key and collapses content by default", () => {
    const message: RelayMessage = {
      key: "custom-1",
      role: "custom",
      customType: "context:global-rules",
      timestamp: 1_700_000_000_000,
      content: "Full custom message body",
    };

    const view = render(<SessionMessageItem message={message} isLast={false} />);

    expect(view.getByText("Custom")).toBeTruthy();
    expect(view.getByText("• context:global-rules")).toBeTruthy();
    expect(view.queryByText("Full custom message body")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Show message" }));

    expect(view.getByText("Full custom message body")).toBeTruthy();
    expect(view.getByRole("button", { name: "Hide message" })).toBeTruthy();
  });

  test("renders display:true custom messages inline", () => {
    const message: RelayMessage = {
      key: "custom-visible",
      role: "custom",
      customType: "plan-complete",
      display: true,
      timestamp: 1_700_000_000_000,
      content: "Visible custom message body",
    };

    const view = render(<SessionMessageItem message={message} isLast={false} />);

    expect(view.getByText("Custom")).toBeTruthy();
    expect(view.getByText("• plan-complete")).toBeTruthy();
    expect(view.getByText("Visible custom message body")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Show message" })).toBeNull();
  });

  test("hides display:false custom messages from the transcript", () => {
    const message: RelayMessage = {
      key: "custom-hidden",
      role: "custom",
      customType: "context:global-rules",
      display: false,
      timestamp: 1_700_000_000_000,
      content: "Hidden custom message body",
    };

    const view = render(<SessionMessageItem message={message} isLast={false} />);

    expect(view.container.innerHTML).toBe("");
  });
});
