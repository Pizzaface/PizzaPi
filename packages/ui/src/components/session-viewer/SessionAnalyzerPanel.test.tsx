import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import type { SessionAnalysis } from "../session-inspector/types";

// Set up DOM globals BEFORE importing the component — CombinedPanel's
// transitive deps (lucide-react, ReactDOM) need a DOM at evaluation time.
const win = new Window({ url: "http://localhost/" });
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
/* eslint-enable @typescript-eslint/no-explicit-any */

mock.module("@/lib/utils", () => ({
  cn: (...classes: (string | undefined | null | false)[]) => classes.filter(Boolean).join(" "),
}));

const CombinedPanelModule = await import("../CombinedPanel");
mock.module("@/components/CombinedPanel", () => CombinedPanelModule);

const { SessionAnalyzerPanel } = await import("./SessionAnalyzerPanel");

afterAll(() => mock.restore());

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).fetch;
});

const analysis: SessionAnalysis = {
  sessionId: "session-1",
  activeModel: { provider: "openai", id: "gpt-4.1-mini", contextWindow: 128000 },
  modelsUsed: [],
  blocks: [
    { turnIndex: 0, entryId: "1", role: "turn", tokens: 120, rawTokenDelta: 120, title: "Turn", usage: { input: 120, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 120 } },
    { turnIndex: 1, entryId: "2", role: "separator", tokens: 0, rawTokenDelta: -40, usage: { input: 80, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 80 } },
    { turnIndex: 2, entryId: "3", role: "turn", tokens: 40, rawTokenDelta: 40, title: "Turn", usage: { input: 120, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 120 } },
  ],
  compactions: [
    {
      entryId: "c1",
      tokensBeforeCompaction: 1000,
      estimatedSummaryTokens: 100,
      estimatedTokensAfter: 200,
      estimatedTokensFreed: 800,
      firstKeptId: "1",
      timestamp: "2026-01-01T00:00:00Z",
    },
  ],
  summary: {
    totalTokens: 205,
    totalCost: 1.2345,
    cacheHitRate: 0.667,
    estimatedCacheSavings: 12.3456,
    compactionCount: 1,
    tokensFreedByCompaction: 800,
    peakContextUsage: 4096,
    contextUtilization: 0.5,
  },
};

describe("SessionAnalyzerPanel", () => {
  test("renders through CombinedPanel and closes via the tab button", () => {
    let closed = 0;
    const { container } = render(
      <SessionAnalyzerPanel analysis={analysis} onClose={() => { closed += 1; }} />,
    );

    expect(container.textContent).toContain("Context & Cache Analysis");
    expect(container.textContent).toContain("Cache hit");
    expect(container.textContent).toContain("66.7%");
    expect(container.textContent).toContain("Peak context");
    expect(container.textContent).toContain("4.1k");
    expect(container.textContent).toContain("Context use");
    expect(container.textContent).toContain("50.0%");
    expect(container.textContent).toContain("Context over time");
    expect(container.textContent).toContain("Largest context pieces");
    expect(container.textContent).toContain("Amber markers show compactions.");
    expect(container.textContent).toContain("120 total");

    const closeButton = Array.from(container.getElementsByTagName("button")).find(
      (el) => el.getAttribute("aria-label") === "Close Context & Cache Analysis",
    ) as HTMLButtonElement | undefined;
    expect(closeButton).toBeTruthy();

    fireEvent.click(closeButton!);
    expect(closed).toBe(1);
  });

  test("uses on-demand reconstructed analysis when no live analysis is available", async () => {
    const reconstructedAnalysis: SessionAnalysis = {
      ...analysis,
      blocks: [
        { turnIndex: -1, entryId: "ctx-1", role: "context:global-rules", tokens: 500, rawTokenDelta: 0, title: "Global Rules" },
        { turnIndex: 0, entryId: "turn-1", role: "turn", tokens: 120, rawTokenDelta: 120 },
      ],
    };
    const fetchMock = mock(async () => ({
      ok: true,
      json: async () => reconstructedAnalysis,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;

    const { container } = render(
      <SessionAnalyzerPanel
        analysis={null}
        runnerId="runner-1"
        sessionId="session-1"
      />,
    );

    await waitFor(() => expect(container.textContent).toContain("2 items"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runners/runner-1/analysis/session-1",
      { headers: { Accept: "application/json" }, credentials: "include" },
    );
  });

  test("live analysis updates supersede an earlier fetched snapshot", async () => {
    const reconstructedAnalysis: SessionAnalysis = {
      ...analysis,
      blocks: [
        { turnIndex: -1, entryId: "ctx-1", role: "context:global-rules", tokens: 500, rawTokenDelta: 0, title: "Global Rules" },
        { turnIndex: 0, entryId: "turn-1", role: "turn", tokens: 120, rawTokenDelta: 120 },
      ],
    };
    const fetchMock = mock(async () => ({
      ok: true,
      json: async () => reconstructedAnalysis,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;

    const view = render(
      <SessionAnalyzerPanel
        analysis={null}
        runnerId="runner-1"
        sessionId="session-1"
      />,
    );

    await waitFor(() => expect(view.container.textContent).toContain("2 items"));

    view.rerender(
      <SessionAnalyzerPanel
        analysis={analysis}
        runnerId="runner-1"
        sessionId="session-1"
      />,
    );

    await waitFor(() => expect(view.container.textContent).toContain("3 items"));
  });
});
