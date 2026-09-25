/**
 * Tests for ApprovalCard — the web decision surface for a gated tool call.
 */
import { afterEach, describe, test, expect } from "bun:test";
import { Window } from "happy-dom";
import { render, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import type { MetaPendingApproval, ApprovalDecision } from "@pizzapi/protocol";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = (win as any).HTMLElement;
(globalThis as any).Element = (win as any).Element;
(globalThis as any).Node = (win as any).Node;
(globalThis as any).getComputedStyle = (win as any).getComputedStyle;

const { ApprovalCard } = await import("./ApprovalCard");

afterEach(() => cleanup());

const approval: MetaPendingApproval = {
  promptId: "a1",
  title: "Send this email?",
  toolName: "gmail_send_email",
  fields: [
    { key: "to", label: "To", value: "bob@example.com", editable: true },
    { key: "body", label: "Body", value: "Hello", editable: true, multiline: true },
    { key: "from", label: "From", value: "me@example.com", editable: false },
  ],
};

describe("ApprovalCard", () => {
  const consent: MetaPendingApproval = {
    promptId: "url-1",
    title: "MCP server: payments",
    fields: [
      { key: "mcp:message", label: "Why the server asks", value: "Open https://phish.example to continue" },
      { key: "mcp:url", label: "Full URL (review before opening)", value: "https://mcp.example.com/ui?flow=1" },
    ],
    actions: [
      { id: "open", label: "Open in browser", style: "primary", href: "https://mcp.example.com/ui?flow=1" },
      { id: "evil", label: "Evil", href: "javascript:alert(1)" },
      { id: "data", label: "Data", href: "data:text/html,x" },
      { id: "cancel", label: "Cancel" },
    ],
  };

  test("URL consent: rendering never navigates or prefetches; only the http(s) action is a noopener link", () => {
    const opened: unknown[] = [];
    (win as any).open = (...args: unknown[]) => { opened.push(args); return null; };
    const { container, getByText } = render(<ApprovalCard approval={consent} onDecision={() => {}} />);
    const anchors = [...container.querySelectorAll("a")];
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("href")).toBe("https://mcp.example.com/ui?flow=1");
    expect(anchors[0].getAttribute("target")).toBe("_blank");
    expect(anchors[0].getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchors[0].getAttribute("referrerpolicy")).toBe("no-referrer");
    // Blocked schemes fall back to plain buttons; message text is inert.
    expect(getByText("Evil").tagName).toBe("BUTTON");
    expect(getByText("Data").tagName).toBe("BUTTON");
    expect(container.querySelector("link[rel=prefetch], link[rel=preconnect], link[rel=dns-prefetch], iframe, img")).toBeNull();
    expect(opened).toEqual([]);
  });

  test("URL consent: clicking the link reports the offered action id, never approve", () => {
    let decision: ApprovalDecision | undefined;
    const { getByText } = render(<ApprovalCard approval={consent} onDecision={d => { decision = d; }} />);
    fireEvent.click(getByText("Open in browser"));
    expect(decision).toEqual({ action: "open", approved: false });
  });

  test("a rejected onDecision promise releases the submitting latch", async () => {
    let calls = 0;
    const { getByText } = render(<ApprovalCard approval={consent} onDecision={async () => { calls++; throw new Error("transport down"); }} />);
    fireEvent.click(getByText("Cancel"));
    await new Promise(r => setTimeout(r, 0));
    fireEvent.click(getByText("Cancel"));
    await new Promise(r => setTimeout(r, 0));
    expect(calls).toBe(2);
  });

  test("MCP form uses labeled inputs and leaves server URLs as non-clickable text", () => {
    let decision: ApprovalDecision | undefined;
    const form: MetaPendingApproval = {
      promptId: "mcp-1",
      title: "MCP server: contacts",
      fields: [
        { key: "message", label: "Information requested", value: "See https://example.com" },
        { key: "name", label: "Name (required)", value: "Alice", editable: true },
      ],
      actions: [
        { id: "approve", label: "Accept" },
        { id: "decline", label: "Decline" },
        { id: "cancel", label: "Cancel" },
      ],
    };
    const { getByLabelText, getByText, container } = render(<ApprovalCard approval={form} onDecision={d => { decision = d; }} />);
    expect((getByLabelText("Name (required)") as HTMLInputElement).value).toBe("Alice");
    expect(container.querySelector("a")).toBeNull();
    fireEvent.change(getByLabelText("Name (required)"), { target: { value: "Bob" } });
    fireEvent.click(getByText("Accept"));
    expect(decision).toEqual({ action: "approve", approved: true, edits: { name: "Bob" } });
  });

  test("shows the title, tool name, and field values", () => {
    const { getByText } = render(<ApprovalCard approval={approval} onDecision={() => {}} />);
    expect(getByText("Send this email?")).toBeDefined();
    expect(getByText("gmail_send_email")).toBeDefined();
    expect(getByText("me@example.com")).toBeDefined(); // read-only field rendered as text
  });

  test("Reject sends an unapproved decision", () => {
    let decision: ApprovalDecision | undefined;
    const { getByText } = render(<ApprovalCard approval={approval} onDecision={(d) => { decision = d; }} />);
    fireEvent.click(getByText("Reject"));
    expect(decision).toEqual({ action: "reject", approved: false });
  });

  test("Approve sends an approved decision (no edits when untouched)", () => {
    let decision: ApprovalDecision | undefined;
    const { getByText } = render(<ApprovalCard approval={approval} onDecision={(d) => { decision = d; }} />);
    fireEvent.click(getByText("Approve"));
    expect(decision).toEqual({ action: "approve", approved: true });
  });

  test("custom actions render and report their id", () => {
    let decision: ApprovalDecision | undefined;
    const custom: MetaPendingApproval = {
      promptId: "a2",
      title: "Pick one",
      actions: [
        { id: "yes", label: "Do it", style: "primary" },
        { id: "no", label: "Skip", style: "danger" },
      ],
    };
    const { getByText } = render(<ApprovalCard approval={custom} onDecision={(d) => { decision = d; }} />);
    fireEvent.click(getByText("Skip"));
    expect(decision).toEqual({ action: "no", approved: false });
  });
});
