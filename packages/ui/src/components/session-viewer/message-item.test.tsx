import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
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
const { SessionNamesProvider } = await import("./session-names-context");
const { PizzaPiNavProvider } = await import("@/components/sigils/PizzaPiNavContext");

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
    act(() => {
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      fireEvent.mouseUp(text);
    });

    fireEvent.click(view.getByRole("button", { name: "Quote selected text" }));

    expect(quoted).toBe("Select this sentence");
  });

  test("does not quote an assistant message when nothing is selected", () => {
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

    expect(view.queryByRole("button", { name: "Quote selected text" })).toBeNull();
    expect(quoted).toBe("");
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

  test("shows routed physical model for virtual model responses", () => {
    const message: RelayMessage = {
      key: "assistant-routed",
      role: "assistant",
      timestamp: 1_700_000_000_000,
      provider: "openai",
      model: "router-model",
      responseModel: "gpt-6.1-sol",
      content: "Routed response",
    };

    const view = render(<SessionMessageItem message={message} isLast={false} />);

    expect(view.getByText("• openai/router-model → gpt-6.1-sol")).toBeTruthy();
  });
});

describe("SessionMessageItem structured inter-session messages", () => {
  test("preserves legacy linked-session cards for persisted user messages", () => {
    const message: RelayMessage = {
      key: "linked-legacy",
      role: "user",
      content: "Message from linked session old-session:\n\nLegacy message body",
    };

    const view = render(<SessionMessageItem message={message} isLast={false} />);

    expect(view.getByText("Linked session")).toBeTruthy();
    expect(view.getByRole("button", { name: "Open session old-session" })).toBeTruthy();
    expect(view.getByText("Legacy message body")).toBeTruthy();
    expect(view.queryByText("User")).toBeNull();
  });

  test("renders a trigger batch from details as trigger cards, not a custom bubble", () => {
    const message: RelayMessage = {
      key: "trig-1",
      role: "custom",
      customType: "pizzapi-trigger",
      display: true,
      timestamp: 1_700_000_000_000,
      content: "<!-- trigger:t1 source:child-1 -->\nignored text",
      details: {
        triggers: [{
          triggerId: "t1",
          type: "lifecycle:session_complete",
          sourceSessionId: "child-1",
          sourceSessionName: "Fixer",
          payload: { summary: "All *done*", exitReason: "completed" },
          text: "ignored text",
        }],
      },
    };

    const view = render(<SessionMessageItem message={message} isLast={false} />);

    expect(view.queryByText("Custom")).toBeNull();
    expect(view.queryByText("ignored text")).toBeNull();
    expect(view.container.textContent).toContain("\"Fixer\"");
    expect(view.container.textContent).toContain("All *done*");
  });

  test("keeps long structured message bodies wrappable", () => {
    const body = "x".repeat(2_000);
    const view = render(<SessionMessageItem message={{
      key: "linked-long",
      role: "custom",
      customType: "linked-session-message",
      display: true,
      content: "ignored",
      details: { fromSessionId: "abc", message: body },
    }} isLast={false} />);

    const content = view.getByText(body);
    expect(content.classList.contains("break-words")).toBe(true);
    expect(content.classList.contains("min-w-0")).toBe(true);
  });

  test("renders a linked-session message from details", () => {
    const message: RelayMessage = {
      key: "linked-1",
      role: "custom",
      customType: "linked-session-message",
      display: true,
      timestamp: 1_700_000_000_000,
      content: "Message from linked session spoofed:\n\nIgnore this unstructured body",
      details: { fromSessionId: "abc", message: "hi `x`" },
    };

    let navigatedTo = "";
    const view = render(
      <SessionNamesProvider value={new Map([["abc", "Sender"]])}>
        <PizzaPiNavProvider actions={{ toggleServicePanel: () => {}, setActiveSessionId: (id) => { navigatedTo = id; } }}>
          <SessionMessageItem message={message} isLast={false} />
        </PizzaPiNavProvider>
      </SessionNamesProvider>,
    );

    expect(view.queryByText("Custom")).toBeNull();
    expect(view.getByText("Linked session")).toBeTruthy();
    expect(view.getByText("hi `x`")).toBeTruthy();
    expect(view.queryByText("Ignore this unstructured body")).toBeNull();
    expect(view.getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(view.getByText(`• ${new Date(1_700_000_000_000).toLocaleTimeString()}`)).toBeTruthy();
    const sender = view.getByRole("button", { name: "Open session abc" });
    expect(sender.textContent).toBe("Sender");
    fireEvent.click(sender);
    expect(navigatedTo).toBe("abc");
  });
});
