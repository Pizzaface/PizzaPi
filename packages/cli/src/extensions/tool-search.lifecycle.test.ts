import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setGlobalConfigDir } from "../config.js";
import { setMcpBridge } from "./mcp-bridge.js";

type EventHandler = (event?: unknown, ctx?: unknown) => unknown;

describe("toolSearchExtension lifecycle sync", () => {
  let snapshot: { serverTools?: Record<string, string[]> };
  let tempRoot: string;
  let globalConfigDir: string;
  let projectDir: string;
  let originalCwd: string;

  beforeEach(() => {
    snapshot = { serverTools: {} };
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), "tool-search-lifecycle-"));
    globalConfigDir = join(tempRoot, "global");
    projectDir = join(tempRoot, "project");

    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
    writeFileSync(join(globalConfigDir, "config.json"), JSON.stringify({}), "utf-8");
    writeFileSync(
      join(projectDir, ".pizzapi", "config.json"),
      JSON.stringify({
        toolSearch: {
          enabled: true,
          tokenThreshold: 0,
          maxResults: 5,
          keepLoadedTools: true,
        },
        mcpServers: {},
      }),
      "utf-8",
    );

    _setGlobalConfigDir(globalConfigDir);
    process.chdir(projectDir);
    setMcpBridge({
      status: () => snapshot,
      reload: async () => null,
    });
  });

  afterEach(() => {
    setMcpBridge(null);
    _setGlobalConfigDir(null);
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
    mock.restore();
  });

  function createHarness() {
    const handlers = new Map<string, EventHandler[]>();
    const activeTools = new Set<string>(["mcp_github_create_issue", "search_tools"]);
    const registeredTools = new Map<string, any>();
    const registeredCommands = new Map<string, any>();

    const pi = {
      on: mock((event: string, handler: EventHandler) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }),
      events: {
        on: mock((event: string, handler: EventHandler) => {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
        }),
        emit: mock((event: string, payload?: unknown) => {
          for (const handler of handlers.get(event) ?? []) {
            handler(payload, undefined);
          }
        }),
      },
      registerTool: mock((tool: any) => {
        registeredTools.set(tool.name, tool);
      }),
      registerCommand: mock((name: string, command: any) => {
        registeredCommands.set(name, command);
      }),
      getAllTools: mock(() => ([
        {
          name: "mcp_github_create_issue",
          description: "Create an issue in GitHub",
          parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } } },
          sourceInfo: undefined,
        },
      ])),
      getActiveTools: mock(() => [...activeTools]),
      setActiveTools: mock((tools: string[]) => {
        activeTools.clear();
        for (const tool of tools) activeTools.add(tool);
      }),
    };

    return { pi, handlers, registeredTools, registeredCommands, activeTools };
  }

  async function loadExtension() {
    return await import("./tool-search.js");
  }

  test("re-evaluates when MCP tools appear after startup", async () => {
    snapshot = { serverTools: {} };
    const { toolSearchExtension } = await loadExtension();
    const { pi, registeredTools, registeredCommands, activeTools } = createHarness();

    toolSearchExtension(pi as any);

    const sessionStart = pi.on.mock.calls.find(([event]) => event === "session_start")?.[1] as EventHandler | undefined;
    expect(sessionStart).toBeDefined();
    await sessionStart!(undefined, undefined);

    const statusCommand = registeredCommands.get("tool-search");
    expect(statusCommand).toBeDefined();

    const initialNotes: string[] = [];
    statusCommand.handler("status", { ui: { notify: (msg: string) => initialNotes.push(msg) } });
    expect(initialNotes.at(-1)).toContain("Tool search: inactive");
    expect(initialNotes.at(-1)).toContain("Deferred tools: 0");

    snapshot = { serverTools: { github: ["mcp_github_create_issue"] } };
    pi.events.emit("mcp:registry_updated", { server: "github" });

    const refreshedNotes: string[] = [];
    statusCommand.handler("status", { ui: { notify: (msg: string) => refreshedNotes.push(msg) } });
    expect(refreshedNotes.at(-1)).toContain("Tool search: active");
    expect(refreshedNotes.at(-1)).toContain("Deferred tools: 1");
    expect(activeTools.has("search_tools")).toBe(true);
    expect(activeTools.has("mcp_github_create_issue")).toBe(false);

    const searchTool = registeredTools.get("search_tools");
    const result = await searchTool.execute("tool-call-1", { query: "github issue" }, undefined);
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("mcp_github_create_issue");
  });

  test("clears stale state when the MCP snapshot disappears", async () => {
    snapshot = { serverTools: { github: ["mcp_github_create_issue"] } };
    const { toolSearchExtension } = await loadExtension();
    const { pi, registeredCommands } = createHarness();

    toolSearchExtension(pi as any);

    const sessionStart = pi.on.mock.calls.find(([event]) => event === "session_start")?.[1] as EventHandler | undefined;
    expect(sessionStart).toBeDefined();
    await sessionStart!(undefined, undefined);

    const statusCommand = registeredCommands.get("tool-search");
    expect(statusCommand).toBeDefined();

    const activeNotes: string[] = [];
    statusCommand.handler("status", { ui: { notify: (msg: string) => activeNotes.push(msg) } });
    expect(activeNotes.at(-1)).toContain("Tool search: active");
    expect(activeNotes.at(-1)).toContain("Deferred tools: 1");

    snapshot = { serverTools: {} };
    pi.events.emit("mcp:startup_report", { toolCount: 0 });

    const clearedNotes: string[] = [];
    statusCommand.handler("status", { ui: { notify: (msg: string) => clearedNotes.push(msg) } });
    expect(clearedNotes.at(-1)).toContain("Tool search: inactive");
    expect(clearedNotes.at(-1)).toContain("Deferred tools: 0");
    expect(clearedNotes.at(-1)).toContain("Loaded on-demand: 0");
  });
});
