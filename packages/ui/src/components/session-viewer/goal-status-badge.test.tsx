import { afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { cleanup, render } from "@testing-library/react";
import * as React from "react";

// Register our own tooltip mock so this file is immune to module mocks leaked
// by earlier test files (bun's mock.module is process-global and mocks are
// resolved-path-keyed, so importing "the actual" back is impossible once a
// mock is registered). Trigger renders inline, content renders nothing —
// matching real (closed) tooltip behavior so text queries stay single-match.
mock.module("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

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

const { TooltipProvider } = await import("@/components/ui/tooltip");
const { GoalStatusBadge } = await import("./goal-status-badge");

afterEach(() => cleanup());

function renderWithTooltip(node: React.ReactNode) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

describe("GoalStatusBadge", () => {
  test("renders active goal with turn count and last reason", () => {
    const { getByText } = renderWithTooltip(
      <GoalStatusBadge
        goal={{
          id: "goal_1",
          description: "tests pass",
          status: "active",
          turnCount: 3,
          maxTurns: 5,
          tokenSpend: 1200,
          costSpend: 0.01,
          lastReason: "still failing",
        }}
      />,
    );

    expect(getByText("/goal active")).toBeDefined();
    expect(getByText(/turn 3\/5/)).toBeDefined();
    expect(getByText(/still failing/)).toBeDefined();
  });

  test("hides when there is no active goal", () => {
    const { container } = renderWithTooltip(
      <GoalStatusBadge goal={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("hides when the goal is no longer active", () => {
    const { container } = renderWithTooltip(
      <GoalStatusBadge
        goal={{
          id: "goal_1",
          description: "tests pass",
          status: "met",
          turnCount: 3,
          tokenSpend: 1200,
          costSpend: 0.01,
        }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
