import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { render, fireEvent, cleanup } from "@testing-library/react";
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
  document.body.innerHTML = "";
});

const { MultipleChoiceQuestions } = await import("./multiple-choice");

describe("MultipleChoiceQuestions", () => {
  test("does not crash when the current step becomes out of bounds after a prompt update", () => {
    const onSubmit = () => true;
    const promptKey = "ask-1";

    const { container, rerender } = render(
      <MultipleChoiceQuestions
        promptKey={promptKey}
        onSubmit={onSubmit}
        questions={[
          { question: "First?", options: ["A", "B"] },
          { question: "Second?", options: ["C", "D"] },
        ]}
      />,
    );

    const firstOption = container.querySelector('input[type="radio"]') as HTMLInputElement | null;
    expect(firstOption).not.toBeNull();
    fireEvent.click(firstOption!);

    const nextButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Next"),
    ) as HTMLButtonElement | undefined;
    expect(nextButton).toBeDefined();
    fireEvent.click(nextButton!);

    expect(container.textContent).toContain("Question 2 of 2");
    expect(container.textContent).toContain("Second?");

    rerender(
      <MultipleChoiceQuestions
        promptKey={promptKey}
        onSubmit={onSubmit}
        questions={[
          { question: "First?", options: ["A", "B"] },
        ]}
      />,
    );

    expect(container.textContent).toContain("Question 1 of 1");
    expect(container.textContent).toContain("First?");
  });
});
