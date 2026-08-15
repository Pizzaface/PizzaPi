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
