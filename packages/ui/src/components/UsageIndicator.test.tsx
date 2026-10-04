import { afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { UsageIndicator } from "./UsageIndicator";

beforeAll(() => {
    const win = new Window({ url: "http://localhost/" });
    Object.assign(win, { SyntaxError });
    Object.assign(globalThis, {
        window: win, document: win.document, navigator: win.navigator,
        HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node,
        MutationObserver: win.MutationObserver,
    });
});
afterEach(cleanup);

test("missing Anthropic OAuth quota stays visible as unknown", () => {
    const { getByRole } = render(<UsageIndicator usage={null} activeProvider="claude-subscription" authSource="oauth" />);
    expect(getByRole("button", { name: "Anthropic subscription usage (unknown)" })).toBeDefined();
});

test("expired Anthropic quota stays visible as unknown", () => {
    const { getByRole } = render(<UsageIndicator usage={{ anthropic: {
        status: "ok", windows: [{ label: "5-hour", utilization: 100, resets_at: "2000-01-01T00:00:00Z" }],
    } }} />);
    expect(getByRole("button", { name: "Anthropic subscription usage (unknown)" })).toBeDefined();
});

test("Claude subscription alias does not duplicate an existing Anthropic badge", () => {
    const { getAllByRole } = render(<UsageIndicator usage={{ anthropic: { status: "unknown", windows: [] } }} activeProvider="claude-subscription" authSource="oauth" />);
    expect(getAllByRole("button", { name: "Anthropic subscription usage (unknown)" })).toHaveLength(1);
});

test("badges show an active refreshing state while usage is being fetched", () => {
    const { getByRole, getByText } = render(<UsageIndicator usage={{ anthropic: { status: "unknown", windows: [] } }} refreshing onRefresh={() => {}} />);
    expect(getByRole("button", { name: "Anthropic subscription usage (refreshing)" })).toBeDefined();
    expect(getByText("REFRESHING")).toBeDefined();
});
