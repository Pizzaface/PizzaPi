import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import React from "react";

const win = new Window({ url: "http://localhost/" });
(win as unknown as { SyntaxError?: typeof SyntaxError }).SyntaxError = SyntaxError;
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as any).SyntaxError = win.SyntaxError;
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
/* eslint-enable @typescript-eslint/no-explicit-any */

afterEach(() => {
  cleanup();
  win.document.body.innerHTML = "";
});

const { MultipleChoiceQuestions } = await import("./multiple-choice");

describe("MultipleChoiceQuestions", () => {
  test.skip("does not crash when the current step becomes out of bounds after a prompt update", async () => {
    const onSubmit = () => true;
    const promptKey = "ask-1";

    const host = win.document.createElement("div");
    win.document.body.appendChild(host);

    const { rerender, getByRole, getByText } = render(
      <MultipleChoiceQuestions
        promptKey={promptKey}
        onSubmit={onSubmit}
        questions={[
          { question: "First?", options: ["A", "B"] },
          { question: "Second?", options: ["C", "D"] },
        ]}
      />,
      {
        container: host,
        baseElement: win.document.body,
      },
    );

    const waitOpts = { container: win.document.body };

    const nextButton = await waitFor(() => getByRole("button", { name: /next/i }), waitOpts);
    expect((nextButton as HTMLButtonElement).disabled).toBe(true);

    const firstOption = await waitFor(() => getByRole("radio", { name: "A" }), waitOpts);
    fireEvent.click(firstOption);

    await waitFor(() => {
      expect((getByRole("button", { name: /next/i }) as HTMLButtonElement).disabled).toBe(false);
    }, waitOpts);

    fireEvent.click(getByRole("button", { name: /next/i }));

    await waitFor(() => {
      expect(getByText("Question 2 of 2")).toBeDefined();
      expect(getByText("Second?")).toBeDefined();
    }, waitOpts);

    rerender(
      <MultipleChoiceQuestions
        promptKey={promptKey}
        onSubmit={onSubmit}
        questions={[
          { question: "First?", options: ["A", "B"] },
        ]}
      />,
    );

    await waitFor(() => {
      expect(getByText("Question 1 of 1")).toBeDefined();
      expect(getByText("First?")).toBeDefined();
    }, waitOpts);
  });
});
