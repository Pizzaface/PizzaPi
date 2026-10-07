import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import React from "react";

const win = new Window({ url: "http://localhost/" });
/* eslint-disable @typescript-eslint/no-explicit-any */
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).HTMLInputElement = win.HTMLInputElement;
(globalThis as any).Event = win.Event;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
/* eslint-enable @typescript-eslint/no-explicit-any */

mock.module("@/components/ui/tool-card", () => ({
  ToolCardShell: ({ children }: any) => <div>{children}</div>,
  ToolCardHeader: ({ children }: any) => <div>{children}</div>,
  ToolCardTitle: ({ children }: any) => <div>{children}</div>,
  StatusPill: ({ children }: any) => <span>{children}</span>,
}));
mock.module("@/components/ui/badge", () => ({
  Badge: ({ children }: any) => <span>{children}</span>,
}));
mock.module("@/components/session-viewer/McpToggleContext", () => ({
  useMcpToggle: () => null,
}));
mock.module("@/lib/utils", () => ({
  cn: (...classes: (string | undefined | null | false)[]) => classes.filter(Boolean).join(" "),
}));

const { CommandResultCard } = await import("./CommandResultCard");
const { PluginCommandContext, PluginResultCountContext } = await import("@/components/plugins/plugins-data");

afterAll(() => mock.restore());

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("CommandResultCard MCP state rendering", () => {
  test("renders loaded, deferred, loaded-on-demand, and disabled MCP state distinctly", () => {
    const data: any = {
      kind: "mcp",
      action: "status",
      toolCount: 3,
      toolNames: ["mcp_github_create_issue", "mcp_github_create_pr", "mcp_linear_search"],
      serverTools: {
        github: ["mcp_github_create_issue", "mcp_github_create_pr"],
        linear: ["mcp_linear_search"],
      },
      serverCount: 3,
      servers: [
        { name: "github", transport: "http", scope: "global", sourcePath: "~/.pizzapi/config.json" },
        { name: "linear", transport: "http", scope: "global", sourcePath: "~/.pizzapi/config.json" },
        { name: "figma", transport: "http", scope: "global", sourcePath: "~/.pizzapi/config.json" },
      ],
      errors: [],
      disabledServers: ["figma"],
      counts: {
        totalTools: 3,
        loadedTools: 0,
        deferredTools: 1,
        loadedOnDemandTools: 2,
        disabledServers: 1,
      },
      serverStates: [
        {
          name: "github",
          transport: "http",
          scope: "global",
          sourcePath: "~/.pizzapi/config.json",
          state: "loaded",
          totalToolCount: 2,
          loadedToolCount: 2,
          deferredToolCount: 0,
          loadedOnDemandToolCount: 2,
        },
        {
          name: "linear",
          transport: "http",
          scope: "global",
          sourcePath: "~/.pizzapi/config.json",
          state: "deferred",
          totalToolCount: 1,
          loadedToolCount: 0,
          deferredToolCount: 1,
          loadedOnDemandToolCount: 0,
        },
        {
          name: "figma",
          transport: "http",
          scope: "global",
          sourcePath: "~/.pizzapi/config.json",
          state: "disabled",
          totalToolCount: 0,
          loadedToolCount: 0,
          deferredToolCount: 0,
          loadedOnDemandToolCount: 0,
        },
      ],
      toolStates: [
        { name: "mcp_github_create_issue", serverName: "github", state: "loaded_on_demand" },
        { name: "mcp_github_create_pr", serverName: "github", state: "loaded_on_demand" },
        { name: "mcp_linear_search", serverName: "linear", state: "deferred" },
      ],
    };

    const { container } = render(<CommandResultCard data={data} />);
    const text = container.textContent ?? "";

    expect(text).toContain("loaded on-demand");
    expect(text).toContain("deferred");
    expect(text).toContain("disabled");
    expect(text).toContain("mcp_github_create_issue");
    expect(text).toContain("mcp_linear_search");
  });
});

describe("CommandResultCard plugins pending state", () => {
  test("stays loading after sending until a new plugin result card arrives", async () => {
    const send = mock(async (_args: string[]) => {});
    const data: any = {
      kind: "plugins",
      overview: { plugins: [], disabled: [], marketplaces: [{ name: "market", source: "a/b", pluginCount: 1 }], packages: [] },
    };
    const tree = (count: number) => (
      <PluginCommandContext.Provider value={send}>
        <PluginResultCountContext.Provider value={count}>
          <CommandResultCard data={data} />
        </PluginResultCountContext.Provider>
      </PluginCommandContext.Provider>
    );
    const { findByText, queryByText, rerender } = render(tree(1));
    await act(async () => { await import("@/components/plugins/PluginsView"); await new Promise((r) => setTimeout(r, 0)); });
    const browse = await findByText("Browse");
    await act(async () => { fireEvent.click(browse); });
    expect(send).toHaveBeenLastCalledWith(["marketplace", "show", "market"]);
    // Send resolved, but the result card hasn't landed yet.
    expect(queryByText("Loading from runner…")).toBeTruthy();
    rerender(tree(2));
    expect(queryByText("Loading from runner…")).toBeNull();

    // Header collapses the whole view and shows a summary.
    fireEvent.click(await findByText("Plugins"));
    expect(queryByText("Browse")).toBeNull();
    expect(queryByText(/1 marketplaces/)).toBeTruthy();
    fireEvent.click(await findByText("Plugins"));

    // Undelivered (send resolves false) → loading clears immediately.
    send.mockImplementation(async () => false as any);
    await act(async () => { fireEvent.click(await findByText("Browse")); });
    expect(queryByText("Loading from runner…")).toBeNull();
  });
});
