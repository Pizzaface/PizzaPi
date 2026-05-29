import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import type { UsageData } from "./types";

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

const { SessionTable } = await import("./SessionTable");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function session(overrides: Partial<UsageData["recentSessions"][number]>): UsageData["recentSessions"][number] {
  return {
    id: "session-00000000",
    project: "/tmp/project",
    projectShort: "project",
    sessionName: "Test session",
    startedAt: "2026-05-28T00:00:00.000Z",
    endedAt: null,
    messageCount: 1,
    totalCost: null,
    primaryModel: "gpt-5.4-mini",
    ...overrides,
  };
}

describe("SessionTable", () => {
  test("renders zero-cost sessions as $0.00 instead of missing data", () => {
    const view = render(
      <SessionTable
        sessions={[
          session({ id: "zero-cost", sessionName: "Zero cost", totalCost: 0, startedAt: "2026-05-28T00:00:01.000Z" }),
          session({ id: "missing-cost", sessionName: "Missing cost", totalCost: null, startedAt: "2026-05-28T00:00:00.000Z" }),
        ]}
      />,
    );

    expect(view.container.textContent).toContain("$0.00");
    expect(view.container.textContent).toContain("—");
  });
});
