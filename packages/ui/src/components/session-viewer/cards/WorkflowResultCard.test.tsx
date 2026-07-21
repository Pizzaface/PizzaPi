import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";
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
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
/* eslint-enable @typescript-eslint/no-explicit-any */

const { WorkflowResultCard } = await import("./WorkflowResultCard");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("WorkflowResultCard", () => {
  test("renders a running workflow with phases and agents", () => {
    const details = {
      name: "deploy",
      status: "running",
      phases: [
        {
          label: "Phase 1: fetch",
          agents: [
            { id: "a1", label: "researcher", prompt: "look things up", status: "done", model: "haiku", tokens: 500 },
            { id: "a2", label: "writer", prompt: "write it up", status: "running" },
          ],
        },
      ],
      totalAgents: 2,
      totalTokens: 500,
    };

    const { container } = render(<WorkflowResultCard details={details} />);
    const text = container.textContent ?? "";

    expect(text).toContain("deploy");
    expect(text).toContain("Phase 1: fetch");
    expect(text).toContain("researcher");
    expect(text).toContain("writer");
    expect(text).toContain("Running");
  });

  test("renders a done workflow and expands agent result on click", () => {
    const details = {
      name: "summarize",
      status: "done",
      phases: [
        {
          label: "Summarize",
          agents: [
            { id: "a1", label: "summarizer", prompt: "summarize", status: "done", result: "The final summary text." },
          ],
        },
      ],
      totalAgents: 1,
      totalTokens: 1200,
    };

    const { container, getByText } = render(<WorkflowResultCard details={details} />);
    expect(container.textContent ?? "").toContain("Done");
    expect(container.textContent ?? "").not.toContain("The final summary text.");

    fireEvent.click(getByText("summarizer").closest("button")!);
    expect(container.textContent ?? "").toContain("The final summary text.");
  });

  test("renders an error workflow with error banner", () => {
    const details = {
      name: "broken",
      status: "error",
      phases: [
        {
          label: "Phase 1",
          agents: [{ id: "a1", prompt: "do a thing", status: "error", error: "boom" }],
        },
      ],
      totalAgents: 1,
      totalTokens: 0,
      error: "Workflow failed: boom",
    };

    const { container } = render(<WorkflowResultCard details={details} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Failed");
    expect(text).toContain("Workflow failed: boom");
  });

  test("handles empty/partial details without crashing", () => {
    const { container: emptyContainer } = render(<WorkflowResultCard details={undefined} />);
    expect(emptyContainer.textContent ?? "").toContain("Workflow");

    const { container: partialContainer } = render(
      <WorkflowResultCard details={{ status: "running", phases: [] }} />,
    );
    expect(partialContainer.textContent ?? "").toContain("No phases yet");

    const { container: malformedContainer } = render(
      <WorkflowResultCard details={{ status: "running", phases: [{ label: "x" }] }} />,
    );
    expect(malformedContainer.textContent ?? "").toContain("Workflow");
  });

  test("falls back to parsing details embedded in tool result content", () => {
    const content = [
      {
        type: "text",
        text: JSON.stringify({
          status: "running",
          phases: [{ label: "Phase A", agents: [{ id: "a1", prompt: "p", status: "pending" }] }],
          totalAgents: 1,
          totalTokens: 0,
        }),
      },
    ];

    const { container } = render(<WorkflowResultCard details={undefined} content={content} />);
    expect(container.textContent ?? "").toContain("Phase A");
  });
});
