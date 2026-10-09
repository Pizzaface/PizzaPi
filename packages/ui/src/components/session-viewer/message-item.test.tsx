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

  test("renders external events from structured fields without leaking the agent envelope", () => {
    const view = render(<SessionMessageItem message={{
      key: "event-check",
      role: "custom",
      customType: "pizzapi-trigger",
      display: true,
      content: "<!-- trigger:check-1 -->\n```json\nUntrusted display text\n```",
      details: { triggers: [{
        triggerId: "check-1",
        type: "github:check_completed",
        expectsResponse: true,
        sourceSessionId: "external:github",
        sourceSessionName: "Legacy combined label",
        sourceName: "GitHub",
        summary: "Check finished",
        payload: { prompt: "AGENT_ONLY_ROUTE_INSTRUCTIONS" },
        displayPayload: {
          checkName: "E2E install flow — npm-local",
          conclusion: "success",
          prompt: "Original event prompt",
          repo: "Pizzaface/PizzaPi",
          prNumber: 932,
          url: "https://github.com/Pizzaface/PizzaPi/actions/runs/123/job/456",
          maliciousUrl: "javascript:alert(1)",
          nested: { attempts: [1, 2], passed: true, error: null },
          empty: null,
          enabled: false,
        },
        text: "<!-- trigger:check-1 -->\n```json\nUntrusted display text\n```",
      }] },
    }} isLast={false} />);

    expect(view.getByText("github:check_completed")).toBeTruthy();
    expect(view.getByText("Check finished")).toBeTruthy();
    expect(view.getByText("GitHub · external:github")).toBeTruthy();
    expect(view.getByText("Response required")).toBeTruthy();
    expect(view.getByText("Original event prompt")).toBeTruthy();
    expect(view.queryByText("Legacy combined label")).toBeNull();
    expect(view.getByText("E2E install flow — npm-local")).toBeTruthy();
    expect(view.getByText("success")).toBeTruthy();
    expect(view.getByText("932")).toBeTruthy();
    expect(view.getByText("false")).toBeTruthy();
    expect(view.getByText("null")).toBeTruthy();
    expect(view.getAllByRole("link")).toHaveLength(1);
    expect(view.getByRole("link").getAttribute("href")).toBe("https://github.com/Pizzaface/PizzaPi/actions/runs/123/job/456");
    expect(view.getByText("javascript:alert(1)")).toBeTruthy();
    expect(view.container.textContent).not.toContain("Unknown trigger type");
    expect(view.container.textContent).not.toContain("Untrusted display text");
    expect(view.container.textContent).not.toContain("AGENT_ONLY_ROUTE_INSTRUCTIONS");
    expect(view.container.textContent).not.toContain("<!-- trigger:");
    expect(view.container.querySelector("details")?.open).toBe(false);
    expect(view.container.querySelector("pre")).toBeNull(); // Collapsed data is not serialized.
  });

  test("bounds wide payloads and pages remaining fields", () => {
    const payload = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`field${i}`, `value${i}`]));
    const view = render(<SessionMessageItem message={{
      key: "event-wide", role: "custom", customType: "pizzapi-trigger",
      details: { triggers: [{ triggerId: "wide", type: "custom:wide", sourceSessionId: "external:service", payload, text: "ignored" }] },
    }} isLast={false} />);
    expect(view.container.querySelectorAll("dt").length).toBeLessThanOrEqual(32);
    expect(view.getByText("value0")).toBeTruthy();
    expect(view.queryByText("value32")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Next payload fields" }));
    expect(view.getByText("value32")).toBeTruthy();
    expect(view.queryByText("value0")).toBeNull();
    expect(view.container.querySelectorAll("dt").length).toBeLessThanOrEqual(32);
  });

  test("does not inspect nested data until expanded, and bounds deep previews", async () => {
    let reads = 0;
    let deep: unknown = "leaf";
    for (let i = 0; i < 10_000; i++) deep = { next: deep };
    const nested = { get expensive() { reads++; return deep; } };
    const view = render(<SessionMessageItem message={{
      key: "event-lazy", role: "custom", customType: "pizzapi-trigger",
      details: { triggers: [{ triggerId: "lazy", type: "custom:lazy", sourceSessionId: "external:service", payload: { nested }, text: "ignored" }] },
    }} isLast={false} />);
    expect(reads).toBe(0);
    expect(view.container.querySelector("pre")).toBeNull();
    const details = view.container.querySelector("details");
    expect(details).toBeTruthy();
    if (!details) throw new Error("Missing payload disclosure");
    act(() => { details.open = true; fireEvent(details, new window.Event("toggle")); });
    expect(reads).toBeGreaterThan(0);
    const text = view.container.querySelector("pre")?.textContent ?? "";
    expect(text).toContain("depth limit");
    expect(text.length).toBeLessThanOrEqual(4_096);
  });

  test("caps expanded previews without executing custom serializers", () => {
    let serializations = 0;
    const nested = {
      toJSON() { serializations++; return "Unexpected serializer result"; },
      ...Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`field${i}`, "x".repeat(5_000)])),
    };
    const view = render(<SessionMessageItem message={{
      key: "event-preview-cap", role: "custom", customType: "pizzapi-trigger",
      details: { triggers: [{ triggerId: "cap", type: "custom:event", sourceSessionId: "external:service", payload: { nested }, text: "ignored" }] },
    }} isLast={false} />);
    const details = view.container.querySelector("details");
    if (!details) throw new Error("Missing payload disclosure");
    act(() => { details.open = true; fireEvent(details, new window.Event("toggle")); });
    const text = view.container.querySelector("pre")?.textContent ?? "";
    expect(serializations).toBe(0);
    expect(text).toContain("preview truncated");
    expect(text.length).toBeLessThanOrEqual(4_096);
  });

  test("preserves ordinary prompt fields without alternate display data", () => {
    const view = render(<SessionMessageItem message={{
      key: "event-ordinary-prompt", role: "custom", customType: "pizzapi-trigger",
      details: { triggers: [{ triggerId: "ordinary", type: "custom:event", sourceSessionId: "external:service", payload: { prompt: "Ordinary event data", displayPayload: { prompt: "Not authoritative" } }, text: "ignored" }] },
    }} isLast={false} />);
    expect(view.getByText("Ordinary event data")).toBeTruthy();
  });

  test.each([
    { payload: "Scalar payload", expected: "Scalar payload" },
    { payload: 42, expected: "42" },
    { payload: false, expected: "false" },
    { payload: null, expected: "null" },
    { payload: ["Array payload", true, null], expected: "Array payload" },
  ])("recovers malformed or historical transcript payload $expected", ({ payload, expected }) => {
    const view = render(<SessionMessageItem message={{
      key: "event-payload",
      role: "custom",
      customType: "pizzapi-trigger",
      details: { triggers: [{ triggerId: "payload", type: "custom:event", sourceSessionId: "external:service", payload, text: "ignored" }] },
    }} isLast={false} />);

    const details = view.container.querySelector("details");
    if (details) act(() => { details.open = true; fireEvent(details, new window.Event("toggle")); });
    expect(view.container.textContent).toContain(expected);
    expect(view.queryByText("No payload fields.")).toBeNull();
    expect(view.container.textContent).not.toContain("ignored");
  });

  test("shows the actual destination of credentialed and deceptive URLs", () => {
    const view = render(<SessionMessageItem message={{
      key: "event-links",
      role: "custom",
      customType: "pizzapi-trigger",
      details: { triggers: [{
        triggerId: "links", type: "custom:event", sourceSessionId: "external:service",
        payload: { credentialed: "https://github.com@evil.example/check", deceptive: "https://github.com.evil.example/check", unsafe: "data:text/html,<script>alert(1)</script>" },
        text: "ignored",
      }] },
    }} isLast={false} />);

    expect(view.getByRole("link", { name: "evil.example" }).getAttribute("href")).toBe("https://github.com@evil.example/check");
    expect(view.getByRole("link", { name: "github.com.evil.example" })).toBeTruthy();
    expect(view.getAllByRole("link")).toHaveLength(2);
    expect(view.queryByText("Open link")).toBeNull();
  });

  test("renders an empty service event and each event in a batch", () => {
    const view = render(<SessionMessageItem message={{
      key: "event-batch",
      role: "custom",
      customType: "pizzapi-trigger",
      details: { triggers: [
        { triggerId: "one", type: "custom:event", sourceSessionId: "external:service", payload: {}, text: "ignored" },
        { triggerId: "two", type: "time:timer_fired", sourceSessionId: "external:time", payload: { message: "Check status" }, text: "ignored" },
      ] },
    }} isLast={false} />);

    expect(view.getByText("custom:event")).toBeTruthy();
    expect(view.getByText("No payload fields.")).toBeTruthy();
    expect(view.getByText("time:timer_fired")).toBeTruthy();
    expect(view.getByText("Check status")).toBeTruthy();
    expect(view.container.textContent).not.toContain("ignored");
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
    const copyButton = view.getByRole("button", { name: "Copy message" });
    expect(copyButton).toBeTruthy();
    // Invisible while unhovered: pointer-events-none so the hidden 44px hit
    // area (-m-2.5 size-11 overflowing the compact header row) doesn't steal
    // taps meant for the message text above/below it (#995-r2 finding 3).
    expect(copyButton.className).toContain("pointer-events-none");
    expect(copyButton.className).toContain("group-hover/msg:pointer-events-auto");
    expect(copyButton.className).toContain("focus-visible:pointer-events-auto");
    expect(view.getByText(`• ${new Date(1_700_000_000_000).toLocaleTimeString()}`)).toBeTruthy();
    const sender = view.getByRole("button", { name: "Open session abc" });
    expect(sender.textContent).toBe("Sender");
    fireEvent.click(sender);
    expect(navigatedTo).toBe("abc");
  });
});
