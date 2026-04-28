/**
 * Tool Search Extension
 *
 * Reduces context window bloat by deferring MCP tools and providing a
 * `search_tools` custom tool that the LLM can call to discover and load
 * them on-demand. Provider-agnostic — works with any model.
 *
 * Decision logic:
 * 1. Tools from MCP servers with `deferLoading: true` in config are always deferred.
 * 2. If total MCP tool char count exceeds `toolSearch.tokenThreshold`, ALL MCP tools
 *    are deferred (except those from servers explicitly marked `deferLoading: false`).
 * 3. Built-in tools (read, bash, edit, write, etc.) are never deferred.
 * 4. The `search_tools` tool itself is always active.
 */
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { loadConfig, type PizzaPiConfig } from "../config.js";
import { getMcpBridge } from "./mcp-bridge.js";
import type { McpConfig } from "./mcp/registry.js";
import { setToolSearchBridge } from "./tool-search-bridge.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("tool-search");

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_TOKEN_THRESHOLD = 10_000; // chars (≈ 2500 tokens)
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_KEEP_LOADED = true;

// ── Types ───────────────────────────────────────────────────────────────────

interface ToolInfo {
  name: string;
  description: string;
  parameterNames: string[];
  /** Serialized char count for token estimation. */
  charCount: number;
  /** Which MCP server this tool belongs to (if any). */
  serverName?: string;
}

type ToolSearchState = {
  /** Tools that have been deferred (removed from active set). */
  deferredTools: Map<string, ToolInfo>;
  /** Tools that have been loaded on-demand via search. */
  loadedTools: Map<string, ToolInfo>;
  /** Whether tool search is actively managing tools this session. */
  active: boolean;
};

// ── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Score a tool against a search query using keyword matching.
 * Higher score = better match.
 */
export function scoreToolMatch(tool: ToolInfo, query: string): number {
  const queryLower = query.toLowerCase();
  const keywords = queryLower
    .split(/[\s_\-:.,;/\\|]+/)
    .filter((k) => k.length > 1);

  if (keywords.length === 0) return 0;

  let score = 0;
  const nameLower = tool.name.toLowerCase();
  const descLower = tool.description.toLowerCase();
  const paramText = tool.parameterNames.join(" ").toLowerCase();

  for (const keyword of keywords) {
    // Exact name match is highest signal
    if (nameLower === keyword) score += 10;
    // Name contains keyword
    else if (nameLower.includes(keyword)) score += 5;
    // Description contains keyword
    if (descLower.includes(keyword)) score += 3;
    // Parameter names contain keyword
    if (paramText.includes(keyword)) score += 1;
  }

  // Bonus for full query appearing as substring
  if (nameLower.includes(queryLower)) score += 8;
  if (descLower.includes(queryLower)) score += 4;

  return score;
}

/**
 * Search deferred tools and return the top matches.
 */
export function searchDeferredTools(
  deferred: Map<string, ToolInfo>,
  query: string,
  maxResults: number,
): ToolInfo[] {
  const scored: Array<{ tool: ToolInfo; score: number }> = [];

  for (const tool of deferred.values()) {
    const score = scoreToolMatch(tool, query);
    if (score > 0) {
      scored.push({ tool, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((s) => s.tool);
}

/**
 * Estimate the character count of a tool definition for token threshold checks.
 */
export function estimateToolChars(tool: { name: string; description: string; parameters: unknown }): number {
  const schemaStr = typeof tool.parameters === "string"
    ? tool.parameters
    : JSON.stringify(tool.parameters ?? {});
  return tool.name.length + (tool.description?.length ?? 0) + schemaStr.length;
}

/**
 * Extract parameter names from a JSON Schema object.
 */
export function extractParamNames(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const obj = schema as Record<string, unknown>;
  if (!obj.properties || typeof obj.properties !== "object") return [];
  return Object.keys(obj.properties as Record<string, unknown>);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Determine which MCP servers have `deferLoading` set.
 * Returns a map of server name → deferLoading value (true/false/undefined).
 */
function getServerDeferConfig(config: PizzaPiConfig & McpConfig): Map<string, boolean | undefined> {
  const result = new Map<string, boolean | undefined>();

  // mcp.servers format
  if (config.mcp?.servers) {
    for (const server of config.mcp.servers) {
      result.set(server.name, (server as any).deferLoading);
    }
  }

  // mcpServers compatibility format
  if (config.mcpServers) {
    for (const [name, serverCfg] of Object.entries(config.mcpServers)) {
      if (serverCfg && typeof serverCfg === "object") {
        result.set(name, (serverCfg as any).deferLoading);
      }
    }
  }

  return result;
}

// ── Extension ───────────────────────────────────────────────────────────────

export const toolSearchExtension: ExtensionFactory = (pi: any) => {
  const state: ToolSearchState = {
    deferredTools: new Map(),
    loadedTools: new Map(),
    active: false,
  };

  function restoreManagedTools(): void {
    const currentActive = new Set(pi.getActiveTools() as string[]);
    for (const name of state.deferredTools.keys()) currentActive.add(name);
    for (const name of state.loadedTools.keys()) currentActive.add(name);
    pi.setActiveTools([...currentActive]);
  }

  function clearState(options?: { restoreActiveTools?: boolean }): void {
    if (options?.restoreActiveTools) {
      restoreManagedTools();
    }
    state.deferredTools.clear();
    state.loadedTools.clear();
    state.active = false;
  }

  setToolSearchBridge({
    status: () => ({
      active: state.active,
      deferredTools: [...state.deferredTools.values()],
      loadedOnDemandTools: [...state.loadedTools.values()],
    }),
  });

  /**
   * Evaluate whether tool search should activate, and if so, which tools to defer.
   * Called after MCP tools are loaded (on session_start, after MCP extension runs).
   */
  function evaluateAndDefer(): void {
    const config = loadConfig(process.cwd());
    const tsConfig = config.toolSearch;

    if (!tsConfig?.enabled) {
      clearState({ restoreActiveTools: true });
      return;
    }

    const threshold = tsConfig.tokenThreshold ?? DEFAULT_TOKEN_THRESHOLD;
    const mcpConfig = config as PizzaPiConfig & McpConfig;
    const serverDeferConfig = getServerDeferConfig(mcpConfig);

    // Get MCP bridge status to know which tools belong to which servers
    const bridge = getMcpBridge();
    const snapshot = bridge?.status() as {
      serverTools?: Record<string, string[]>;
      toolNames?: string[];
    } | null;

    if (!snapshot?.serverTools) {
      log.info("No MCP tools found, tool search not needed");
      clearState({ restoreActiveTools: true });
      return;
    }

    // Build reverse map: tool name → server name
    const toolToServer = new Map<string, string>();
    for (const [serverName, toolNames] of Object.entries(snapshot.serverTools)) {
      for (const toolName of toolNames) {
        toolToServer.set(toolName, serverName);
      }
    }

    // Get all registered tools
    const allTools: Array<{ name: string; description: string; parameters: unknown; sourceInfo: unknown }> = pi.getAllTools();

    // Identify MCP tools and calculate their total char count
    const mcpTools: Array<typeof allTools[number] & { serverName: string }> = [];
    let totalMcpChars = 0;

    for (const tool of allTools) {
      const serverName = toolToServer.get(tool.name);
      if (serverName) {
        const chars = estimateToolChars(tool);
        totalMcpChars += chars;
        mcpTools.push({ ...tool, serverName });
      }
    }

    // Determine which tools to defer
    const thresholdExceeded = totalMcpChars > threshold;
    const toolsToDefer: string[] = [];

    for (const tool of mcpTools) {
      const serverDefer = serverDeferConfig.get(tool.serverName);

      // Explicitly marked for deferral → always defer
      if (serverDefer === true) {
        toolsToDefer.push(tool.name);
        continue;
      }

      // Explicitly marked to NOT defer → never defer
      if (serverDefer === false) {
        continue;
      }

      // No explicit config → defer if threshold exceeded
      if (thresholdExceeded) {
        toolsToDefer.push(tool.name);
      }
    }

    if (toolsToDefer.length === 0) {
      log.info(`Tool search: no tools to defer (${totalMcpChars} chars, threshold ${threshold})`);
      clearState({ restoreActiveTools: true });
      return;
    }

    const previousLoadedTools = new Map(state.loadedTools);

    // Build deferred tool info map
    state.deferredTools.clear();
    for (const toolName of toolsToDefer) {
      const tool = allTools.find((t) => t.name === toolName);
      if (!tool) continue;

      state.deferredTools.set(toolName, {
        name: tool.name,
        description: tool.description ?? "",
        parameterNames: extractParamNames(tool.parameters),
        charCount: estimateToolChars(tool),
        serverName: toolToServer.get(tool.name),
      });
    }

    // Preserve any tools that were previously loaded on-demand and are still active.
    const currentActive = new Set(pi.getActiveTools() as string[]);
    state.loadedTools.clear();
    for (const [name, info] of previousLoadedTools) {
      if (currentActive.has(name)) {
        state.loadedTools.set(name, info);
      }
    }

    const loadedOnDemandNames = new Set(state.loadedTools.keys());
    for (const name of loadedOnDemandNames) {
      state.deferredTools.delete(name);
    }

    // Deactivate deferred tools
    for (const name of toolsToDefer) {
      if (loadedOnDemandNames.has(name)) continue;
      currentActive.delete(name);
    }
    // Ensure search_tools stays active
    currentActive.add("search_tools");
    pi.setActiveTools([...currentActive]);

    state.active = true;
    log.info(
      `Tool search active: deferred ${state.deferredTools.size} tools ` +
      `(${totalMcpChars} chars, threshold ${threshold})`
    );
  }

  // ── Register the search_tools tool ──────────────────────────────────────

  pi.registerTool({
    name: "search_tools",
    label: "Search Tools",
    description:
      "Search for available tools by keyword query. " +
      "Some tools are deferred to save context space — use this to discover and load them. " +
      "Returns matching tool names and descriptions. Matched tools are automatically loaded " +
      "and become available for use in subsequent tool calls.",
    promptSnippet:
      "Search for and load deferred MCP tools by keyword. " +
      "Use when you need a tool that isn't currently available.",
    promptGuidelines: [
      "Use search_tools when you need to call a tool that isn't in your current tool list.",
      "Search with descriptive keywords about what you want to do (e.g., 'create github issue', 'send slack message').",
      "After search_tools returns results, the matched tools are loaded and ready to use.",
    ],
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query — keywords describing the tool you need",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: { query: string }, _signal: AbortSignal | undefined) {
      if (!state.active || state.deferredTools.size === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "Tool search is not active — all tools are already loaded in context.",
          }],
          details: { active: false },
        };
      }

      const config = loadConfig(process.cwd());
      const maxResults = config.toolSearch?.maxResults ?? DEFAULT_MAX_RESULTS;
      const keepLoaded = config.toolSearch?.keepLoadedTools ?? DEFAULT_KEEP_LOADED;

      const matches = searchDeferredTools(state.deferredTools, params.query, maxResults);

      if (matches.length === 0) {
        // Show all available deferred tools as fallback
        const available = [...state.deferredTools.values()]
          .map((t) => `- ${t.name}: ${t.description.slice(0, 100)}`)
          .join("\n");

        return {
          content: [{
            type: "text" as const,
            text: `No tools matched "${params.query}". Available deferred tools:\n${available}`,
          }],
          details: { query: params.query, matches: 0 },
        };
      }

      // Activate the matched tools
      const currentActive = new Set(pi.getActiveTools() as string[]);
      const newlyLoaded: string[] = [];

      for (const match of matches) {
        if (!currentActive.has(match.name)) {
          currentActive.add(match.name);
          newlyLoaded.push(match.name);
          state.loadedTools.set(match.name, match);
          // Remove from deferred while loaded, even if keepLoadedTools=false.
          state.deferredTools.delete(match.name);
        }
      }

      if (newlyLoaded.length > 0) {
        pi.setActiveTools([...currentActive]);
      }

      const resultLines = matches.map((t) => {
        const params = t.parameterNames.length > 0
          ? ` (params: ${t.parameterNames.join(", ")})`
          : "";
        return `- **${t.name}**${params}: ${t.description}`;
      });

      const loadedMsg = newlyLoaded.length > 0
        ? `\n\n✅ Loaded ${newlyLoaded.length} tool(s): ${newlyLoaded.join(", ")}. They are now available for use.`
        : "\n\nAll matched tools were already loaded.";

      const remainingDeferred = state.deferredTools.size;
      const deferredMsg = remainingDeferred > 0
        ? `\n\n${remainingDeferred} more deferred tool(s) available — search again if needed.`
        : "";

      return {
        content: [{
          type: "text" as const,
          text: `Found ${matches.length} tool(s) matching "${params.query}":\n\n${resultLines.join("\n")}${loadedMsg}${deferredMsg}`,
        }],
        details: {
          query: params.query,
          matches: matches.length,
          loaded: newlyLoaded,
          remainingDeferred,
        },
      };
    },
  });

  // ── Register /tool-search command ───────────────────────────────────────

  pi.registerCommand?.("tool-search", {
    description: "Tool search status: /tool-search [status|reset]",
    getArgumentCompletions: (prefix: string) => {
      const cmds = ["status", "reset"];
      const matches = cmds.filter((c) => c.startsWith(prefix.trim().toLowerCase()));
      return matches.length > 0 ? matches.map((c) => ({ value: c, label: c })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = (args ?? "").trim().toLowerCase();

      if (arg === "reset") {
        evaluateAndDefer();
        ctx?.ui?.notify?.(`Tool search reset. ${state.deferredTools.size} tools deferred.`);
        return;
      }

      // Default: status
      const lines: string[] = [];
      lines.push(`Tool search: ${state.active ? "active" : "inactive"}`);
      lines.push(`Deferred tools: ${state.deferredTools.size}`);
      lines.push(`Loaded on-demand: ${state.loadedTools.size}`);

      if (state.deferredTools.size > 0) {
        lines.push("");
        lines.push("Deferred:");
        for (const tool of state.deferredTools.values()) {
          lines.push(`  - ${tool.name} [${tool.serverName ?? "unknown"}]: ${tool.description.slice(0, 80)}`);
        }
      }

      if (state.loadedTools.size > 0) {
        lines.push("");
        lines.push("Loaded on-demand:");
        for (const tool of state.loadedTools.values()) {
          lines.push(`  - ${tool.name}`);
        }
      }

      ctx?.ui?.notify?.(lines.join("\n"));
    },
  });

  // ── Session lifecycle ───────────────────────────────────────────────────

  // Keep tool search synchronized with MCP registry changes, including
  // background completion of slow servers and /mcp reload.
  pi.events?.on?.("mcp:startup_report", evaluateAndDefer);
  pi.events?.on?.("mcp:registry_updated", evaluateAndDefer);

  // Use a small delay after session_start to let MCP extension finish loading.
  // The MCP extension also runs on session_start, and extension factories are
  // loaded in order (MCP is registered before tool-search in factories.ts).
  // Since session_start handlers fire in registration order, MCP tools should
  // already be available when our handler runs.
  pi.on?.("session_start", async (_event: any, _ctx: any) => {
    // Small delay to ensure MCP tools are fully registered
    await new Promise((resolve) => setTimeout(resolve, 100));
    evaluateAndDefer();
  });

  // If keepLoadedTools is false, deactivate on-demand tools after each turn
  pi.on?.("turn_end", async (_event: any, _ctx: any) => {
    if (!state.active) return;

    const config = loadConfig(process.cwd());
    const keepLoaded = config.toolSearch?.keepLoadedTools ?? DEFAULT_KEEP_LOADED;

    if (keepLoaded) return;

    // Re-defer tools that were loaded on-demand
    const currentActive = new Set(pi.getActiveTools() as string[]);
    for (const [name, info] of state.loadedTools) {
      currentActive.delete(name);
      state.deferredTools.set(name, info);
    }
    pi.setActiveTools([...currentActive]);
    state.loadedTools.clear();
  });

  pi.on?.("session_shutdown", async () => {
    clearState();
    setToolSearchBridge(null);
  });
};
