import { describe, expect, test } from "bun:test";
import { buildMcpStatusModel, decorateMcpSnapshotWithToolSearchState, reconcileMcpActiveTools, shouldLogMcpEagerInitFailure } from "./mcp-extension.js";

describe("shouldLogMcpEagerInitFailure", () => {
  test("suppresses expected pre-runtime and abort eager init failures", () => {
    expect(shouldLogMcpEagerInitFailure(new Error("Extension runtime not initialized. Action methods cannot be called during extension loading."))).toBe(false);
    expect(shouldLogMcpEagerInitFailure(new Error("operation aborted"))).toBe(false);
  });

  test("keeps unexpected eager init failures visible", () => {
    expect(shouldLogMcpEagerInitFailure(new Error("stdio handshake failed"))).toBe(true);
    expect(shouldLogMcpEagerInitFailure("stdio handshake failed")).toBe(true);
  });
});

describe("buildMcpStatusModel", () => {
  test("classifies loaded, deferred, partial, and disabled MCP state", () => {
    const model = buildMcpStatusModel({
      effectiveServers: [
        { name: "github", transport: "http", scope: "global", keyPath: "mcpServers.github", format: "mcpServers", sourcePath: "~/.pizzapi/config.json" },
        { name: "linear", transport: "http", scope: "global", keyPath: "mcpServers.linear", format: "mcpServers", sourcePath: "~/.pizzapi/config.json" },
        { name: "figma", transport: "http", scope: "global", keyPath: "mcpServers.figma", format: "mcpServers", sourcePath: "~/.pizzapi/config.json" },
      ],
      disabledServers: ["figma"],
      serverTools: {
        github: ["mcp_github_create_issue", "mcp_github_create_pr"],
        linear: ["mcp_linear_search"],
      },
      toolSearch: {
        active: true,
        deferredTools: [
          {
            name: "mcp_github_create_pr",
            description: "Create a PR",
            parameterNames: ["title"],
            charCount: 100,
            serverName: "github",
          },
          {
            name: "mcp_linear_search",
            description: "Search Linear",
            parameterNames: ["query"],
            charCount: 100,
            serverName: "linear",
          },
        ],
        loadedOnDemandTools: [],
      },
    });

    expect(model.counts).toEqual({
      totalTools: 3,
      loadedTools: 1,
      deferredTools: 2,
      loadedOnDemandTools: 0,
      disabledServers: 1,
    });

    expect(model.serverStates).toHaveLength(3);
    expect(model.serverStates).toContainEqual(
      expect.objectContaining({ name: "figma", state: "disabled" }),
    );
    expect(model.serverStates).toContainEqual(
      expect.objectContaining({ name: "github", state: "partial", loadedToolCount: 1, deferredToolCount: 1 }),
    );
    expect(model.serverStates).toContainEqual(
      expect.objectContaining({ name: "linear", state: "deferred", loadedToolCount: 0, deferredToolCount: 1 }),
    );

    expect(model.toolStates).toEqual([
      expect.objectContaining({ name: "mcp_github_create_issue", serverName: "github", state: "loaded" }),
      expect.objectContaining({ name: "mcp_github_create_pr", serverName: "github", state: "deferred" }),
      expect.objectContaining({ name: "mcp_linear_search", serverName: "linear", state: "deferred" }),
    ]);
  });

  test("marks loaded-on-demand tools distinctly from always-loaded tools", () => {
    const model = buildMcpStatusModel({
      effectiveServers: [
        { name: "github", transport: "http", scope: "global", keyPath: "mcpServers.github", format: "mcpServers", sourcePath: "~/.pizzapi/config.json" },
      ],
      disabledServers: [],
      serverTools: {
        github: ["mcp_github_create_issue", "mcp_github_create_pr"],
      },
      toolSearch: {
        active: true,
        deferredTools: [
          {
            name: "mcp_github_create_pr",
            description: "Create a PR",
            parameterNames: ["title"],
            charCount: 100,
            serverName: "github",
          },
        ],
        loadedOnDemandTools: [
          {
            name: "mcp_github_create_issue",
            description: "Create issue",
            parameterNames: ["title"],
            charCount: 100,
            serverName: "github",
          },
        ],
      },
    });

    expect(model.counts).toEqual({
      totalTools: 2,
      loadedTools: 0,
      deferredTools: 1,
      loadedOnDemandTools: 1,
      disabledServers: 0,
    });
    expect(model.serverStates).toEqual([
      expect.objectContaining({ name: "github", state: "partial", loadedToolCount: 0, deferredToolCount: 1, loadedOnDemandToolCount: 1 }),
    ]);
    expect(model.toolStates).toEqual([
      expect.objectContaining({ name: "mcp_github_create_issue", state: "loaded_on_demand" }),
      expect.objectContaining({ name: "mcp_github_create_pr", state: "deferred" }),
    ]);
  });

  test("reconcileMcpActiveTools does not re-activate tools that are still deferred after reload", () => {
    const result = reconcileMcpActiveTools({
      currentActive: ["search_tools"],
      previousMcpToolNames: ["mcp_github_create_issue"],
      newMcpToolNames: ["mcp_github_create_issue", "mcp_github_create_pr"],
      deferredToolNames: ["mcp_github_create_pr"],
    });

    expect(result).toContain("search_tools");
    expect(result).toContain("mcp_github_create_issue");
    expect(result).not.toContain("mcp_github_create_pr");
  });

  test("decorates cached snapshots with current tool-search state", () => {
    const decorated = decorateMcpSnapshotWithToolSearchState({
      toolCount: 2,
      toolNames: ["mcp_github_create_issue", "mcp_github_create_pr"],
      serverTools: {
        github: ["mcp_github_create_issue", "mcp_github_create_pr"],
      },
      errors: [],
      loadedAt: "2026-04-28T20:00:00.000Z",
      config: {
        global: { scope: "global", path: "~/.pizzapi/config.json", exists: true, hasMcpKey: false, hasMcpServersKey: true, preferredServers: [], compatibilityServers: [] },
        project: { scope: "project", path: ".pizzapi/config.json", exists: false, hasMcpKey: false, hasMcpServersKey: false, preferredServers: [], compatibilityServers: [] },
        effectivePreferredSource: "none",
        effectiveCompatibilitySource: "global",
        effectiveServers: [
          { name: "github", transport: "http", scope: "global", keyPath: "mcpServers.github", format: "mcpServers", sourcePath: "~/.pizzapi/config.json" },
        ],
        disabledServers: [],
      },
      summary: "stale",
      lines: ["stale"],
      serverStates: [],
      toolStates: [],
      counts: {
        totalTools: 0,
        loadedTools: 0,
        deferredTools: 0,
        loadedOnDemandTools: 0,
        disabledServers: 0,
      },
      serverTimings: [],
      totalDurationMs: 0,
    } as any, {
      active: true,
      deferredTools: [
        {
          name: "mcp_github_create_pr",
          description: "Create a PR",
          parameterNames: ["title"],
          charCount: 100,
          serverName: "github",
        },
      ],
      loadedOnDemandTools: [
        {
          name: "mcp_github_create_issue",
          description: "Create issue",
          parameterNames: ["title"],
          charCount: 100,
          serverName: "github",
        },
      ],
    });

    expect(decorated.summary).toContain("1 loaded on-demand");
    expect(decorated.summary).toContain("1 deferred");
    expect(decorated.lines[0]).toContain("1 loaded on-demand");
    expect(decorated.lines[0]).toContain("1 deferred");
    expect(decorated.toolStates).toEqual([
      expect.objectContaining({ name: "mcp_github_create_issue", state: "loaded_on_demand" }),
      expect.objectContaining({ name: "mcp_github_create_pr", state: "deferred" }),
    ]);
  });
});
