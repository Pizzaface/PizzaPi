/**
 * Pure parsers for runner `exec_result` payloads and related HTTP responses.
 * Every function tolerates arbitrary (untrusted) input.
 */
import type { McpResultData } from "@/components/session-viewer/cards/CommandResultCard";
import type { ForkMessageOption, ResumeSessionOption } from "@/lib/types";

type ExecResult = Record<string, unknown> | null | undefined;

/** Normalize `result.sessions` from `list_resume_sessions`. Invalid entries are skipped. */
export function parseResumeSessionList(result: ExecResult): ResumeSessionOption[] {
  const list: unknown[] = Array.isArray(result?.sessions) ? (result.sessions as unknown[]) : [];
  const normalized: ResumeSessionOption[] = [];

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.path !== "string" || typeof entry.modified !== "string") {
      continue;
    }
    normalized.push({
      id: entry.id,
      path: entry.path,
      cwd: typeof entry.cwd === "string" ? entry.cwd : null,
      name: typeof entry.name === "string" ? entry.name : null,
      modified: entry.modified,
      firstMessage: typeof entry.firstMessage === "string" ? entry.firstMessage : undefined,
    });
  }
  return normalized;
}

/** Normalize `result.messages` from `get_fork_messages`. */
export function parseForkMessageList(result: ExecResult): ForkMessageOption[] {
  const list: unknown[] = Array.isArray(result?.messages) ? (result.messages as unknown[]) : [];
  const normalized: ForkMessageOption[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.entryId !== "string" || typeof entry.text !== "string") continue;
    normalized.push({ entryId: entry.entryId, text: entry.text });
  }
  return normalized;
}

/** Append `incoming` to `prev`, skipping ids already present. */
export function appendUniqueResumeSessions(
  prev: ResumeSessionOption[],
  incoming: ResumeSessionOption[],
): ResumeSessionOption[] {
  const existingIds = new Set(prev.map((s) => s.id));
  const newItems = incoming.filter((s) => !existingIds.has(s.id));
  return [...prev, ...newItems];
}

/** Server `/api/sessions?includePersisted=1` persisted-session row. */
export interface PersistedSessionRow {
  sessionId: string;
  cwd: string;
  sessionName: string | null;
  lastActiveAt: string;
  runnerId: string | null;
  runnerName: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** Map server-persisted sessions into resume options (resumed by id, not path). */
export function mapPersistedSessions(persisted: PersistedSessionRow[]): ResumeSessionOption[] {
  return persisted.map((s) => ({
    id: s.sessionId,
    path: "", // Server-sourced sessions don't have the .jsonl path; resume uses resumeId instead
    cwd: s.cwd || null,
    name: s.sessionName || null,
    modified: s.lastActiveAt || s.startedAt,
    runnerId: s.runnerId,
    runnerName: s.runnerName,
    serverSourced: true,
  }));
}

/**
 * Build the structured MCP command card from a `/mcp` or `mcp_toggle_server`
 * exec result. `action` is forced by the caller for toggles ("reload");
 * otherwise it's read from the result (anything but "reload" → "status").
 */
export function buildMcpCommandResult(result: ExecResult, forcedAction?: "reload"): McpResultData {
  const toolCount = typeof result?.toolCount === "number" ? result.toolCount : 0;
  const toolNames = Array.isArray(result?.toolNames)
    ? result.toolNames.filter((n: unknown): n is string => typeof n === "string")
    : [];
  const errors = Array.isArray(result?.errors) ? result.errors as Array<{ server: string; error: string }> : [];
  const mcpConfig = result?.config && typeof result.config === "object" ? result.config as Record<string, unknown> : null;
  const servers = Array.isArray(mcpConfig?.effectiveServers)
    ? (mcpConfig.effectiveServers as Array<{ name: string; transport: string; scope: string; sourcePath?: string }>)
    : [];
  const action = forcedAction
    ?? (typeof result?.action === "string" && result.action === "reload" ? "reload" as const : "status" as const);
  // serverTools: Record<string, string[]> — tools grouped by MCP server name
  const serverTools = result?.serverTools && typeof result.serverTools === "object" && !Array.isArray(result.serverTools)
    ? result.serverTools as Record<string, string[]>
    : {};

  const disabledServers = Array.isArray(mcpConfig?.disabledServers)
    ? (mcpConfig.disabledServers as unknown[]).filter((s: unknown): s is string => typeof s === "string")
    : [];
  const counts = result?.counts && typeof result.counts === "object"
    ? result.counts as McpResultData["counts"]
    : undefined;
  const serverStates = Array.isArray(result?.serverStates)
    ? result.serverStates as McpResultData["serverStates"]
    : undefined;
  const toolStates = Array.isArray(result?.toolStates)
    ? result.toolStates as McpResultData["toolStates"]
    : undefined;

  return {
    kind: "mcp",
    action,
    toolCount,
    toolNames,
    serverCount: servers.length,
    servers,
    errors,
    serverTools,
    disabledServers,
    counts,
    serverStates,
    toolStates,
    loadedAt: typeof result?.loadedAt === "string" ? result.loadedAt : undefined,
  };
}

/** Status line after a `compact` exec succeeds. */
export function formatCompactSummary(result: ExecResult): string {
  const tokensBefore = typeof result?.tokensBefore === "number" ? result.tokensBefore : 0;
  return typeof result?.summary === "string"
    ? `Compacted (${tokensBefore > 0 ? `${Math.round(tokensBefore / 1000)}k tokens summarized` : "done"})`
    : "Compacted";
}
