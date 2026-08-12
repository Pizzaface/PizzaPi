import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { cleanup, render } from "@testing-library/react";
import * as React from "react";

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

const { default: GoalEvaluatorSettings, buildGoalConfigPatch } = await import("./GoalEvaluatorSettings");

afterEach(() => cleanup());

/* eslint-disable @typescript-eslint/no-explicit-any */
function renderPanel(overrides: Record<string, unknown> = {}, onSave = (_k: string, _v: unknown) => {}) {
  return render(
    <GoalEvaluatorSettings
      {...({
        runnerId: "runner-1",
        config: { goal: overrides },
        onSave,
        saving: false,
      } as any)}
    />,
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("GoalEvaluatorSettings", () => {
  test("exposes max tokens and cadence controls", () => {
    const { getByLabelText } = renderPanel();
    expect(getByLabelText("Max Tokens")).toBeDefined();
    expect(getByLabelText("Evaluate Every N Runs")).toBeDefined();
    expect(getByLabelText("Minimum Runs Before Evaluating")).toBeDefined();
  });

  test("offers no evaluator model picker", () => {
    // The evaluator runs on the session's model so its judge call can read
    // the conversation from the provider's prompt cache. Choosing a separate
    // model here would silently opt out of that.
    const { queryByLabelText } = renderPanel();
    expect(queryByLabelText("Provider")).toBeNull();
    expect(queryByLabelText("Model")).toBeNull();
  });

  test("preserves a pinned evaluatorModel it no longer edits", () => {
    // The pinned-model escape hatch lives in config.json only. Saving from
    // this panel must not drop it.
    const patch = buildGoalConfigPatch({
      existing: { evaluatorModel: "ollama:qwen3", evaluatorMaxTokens: 512 },
      maxTokens: 256,
      evaluateEveryNTurns: 1,
      minTurnsBeforeEvaluate: 1,
    });

    expect(patch.evaluatorModel).toBe("ollama:qwen3");
    expect(patch.evaluatorMaxTokens).toBe(256);
  });

  test("omits cadence values that match the defaults", () => {
    // Defaults are left unset so a future change to them isn't frozen into
    // every user's config.
    const patch = buildGoalConfigPatch({
      existing: {},
      maxTokens: 512,
      evaluateEveryNTurns: 1,
      minTurnsBeforeEvaluate: 1,
    });

    expect(patch.evaluateEveryNTurns).toBeUndefined();
    expect(patch.minTurnsBeforeEvaluate).toBeUndefined();

    const custom = buildGoalConfigPatch({
      existing: {},
      maxTokens: 512,
      evaluateEveryNTurns: 3,
      minTurnsBeforeEvaluate: 5,
    });

    expect(custom.evaluateEveryNTurns).toBe(3);
    expect(custom.minTurnsBeforeEvaluate).toBe(5);
  });
});
