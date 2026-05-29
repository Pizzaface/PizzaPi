import { afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, cleanup, render, waitFor } from "@testing-library/react";
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
(globalThis as any).ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
/* eslint-enable @typescript-eslint/no-explicit-any */

const { UsageDashboard } = await import("./UsageDashboard");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).fetch;
});

function usageData(totalSessions: number): UsageData {
  return {
    generatedAt: "2026-05-28T00:00:00.000Z",
    dateRange: { from: "2026-05-01", to: "2026-05-28" },
    totalDateRange: { from: "2026-05-01", to: "2026-05-28" },
    summary: {
      totalSessions,
      totalCost: totalSessions,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      avgSessionCost: 1,
      avgSessionTokens: 0,
      avgSessionDurationMs: null,
      sessionsWithCost: totalSessions,
    },
    daily: [],
    byModel: [],
    byProject: [],
    recentSessions: [],
  };
}

describe("UsageDashboard", () => {
  test("ignores late responses for a previous runner or range", async () => {
    const pending: Array<{
      url: string;
      resolve: (data: UsageData) => void;
    }> = [];

    const fetchMock = mock((url: string | URL | Request) => new Promise((resolve) => {
      pending.push({
        url: String(url),
        resolve: (data) => resolve({ ok: true, json: async () => data }),
      });
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;

    const view = render(<UsageDashboard runnerId="runner-1" />);

    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]?.url).toBe("/api/runners/runner-1/usage?range=90d");

    view.rerender(<UsageDashboard runnerId="runner-2" />);

    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1]?.url).toBe("/api/runners/runner-2/usage?range=90d");

    await act(async () => {
      pending[1]!.resolve(usageData(7));
      await Promise.resolve();
    });

    await waitFor(() => expect(view.container.textContent).toContain("7 of 7 sessions with cost data"));

    await act(async () => {
      pending[0]!.resolve(usageData(90));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain("7 of 7 sessions with cost data");
    expect(view.container.textContent).not.toContain("90 of 90 sessions with cost data");
  });
});
