import type { RelayMessage } from "./types";

/**
 * Scan a messages array for in-flight tool calls: toolCall blocks in assistant
 * messages that have no matching toolResult message yet.
 *
 * Used on reconnect (session_active) to restore `activeToolCalls` so streaming
 * indicators and Kill buttons remain visible for long-running commands.
 */
export function detectInFlightTools(messages: RelayMessage[]): Map<string, string> {
  // Collect all toolCallIds from assistant content blocks.
  const pending = new Map<string, string>(); // toolCallId → toolName
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "toolCall") continue;
      const toolCallId =
        typeof b.toolCallId === "string" ? b.toolCallId
        : typeof b.id === "string" ? b.id
        : "";
      const toolName = typeof b.name === "string" ? b.name : "unknown";
      if (toolCallId) pending.set(toolCallId, toolName);
    }
  }
  // Remove any that have a matching toolResult.
  for (const msg of messages) {
    if (msg.role !== "toolResult" && msg.role !== "tool") continue;
    if (msg.toolCallId) pending.delete(msg.toolCallId);
  }
  return pending;
}

export function hasVisibleContent(content: unknown): boolean {
  if (content === undefined || content === null || content === "") return false;
  if (Array.isArray(content)) {
    return content.some((block) => {
      if (!block || typeof block !== "object") return false;
      const b = block as Record<string, unknown>;
      if (b.type === "text")
        return typeof b.text === "string" && b.text.trim() !== "";
      if (b.type === "thinking")
        return typeof b.thinking === "string" && b.thinking.trim() !== "";
      return true;
    });
  }
  return true;
}

export function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function normalizeToolName(toolName?: string): string {
  let name = (toolName ?? "").trim().toLowerCase();
  // Strip Claude Code MCP prefix: mcp__servername__toolname → toolname
  if (name.startsWith("mcp__")) {
    const sep = name.indexOf("__", 5); // 5 = "mcp__".length
    if (sep !== -1) name = name.slice(sep + 2);
  }
  // Strip pizzapi_ prefix used by PizzaPi MCP tools
  // (e.g. pizzapi_spawn_session → spawn_session)
  if (name.startsWith("pizzapi_")) {
    name = name.slice(8);
  }
  return name;
}

export function extractTextFromToolContent(content: unknown): string | null {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") {
        parts.push(b.text);
      } else if (typeof b.content === "string") {
        parts.push(b.content);
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
  }

  return null;
}

export function extractPathFromToolContent(content: unknown): string | undefined {
  if (!content || typeof content !== "object") return undefined;

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (typeof b.path === "string") return b.path;
    }
    return undefined;
  }

  const obj = content as Record<string, unknown>;
  return typeof obj.path === "string" ? obj.path : undefined;
}

export function estimateBase64Bytes(data: string): number {
  const base64 = data.includes(",") ? data.split(",").pop() ?? "" : data;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

export function formatDateValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value > 10_000_000_000 ? value : value * 1000);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
  }

  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
    return value;
  }

  return null;
}

/**
 * Safely coerce `toolInput` to a plain object.
 *
 * Replaces the repeated pattern:
 * ```ts
 * const inputArgs = toolInput && typeof toolInput === "object"
 *   ? (toolInput as Record<string, unknown>)
 *   : {};
 * ```
 */
export function parseToolInputArgs(
  toolInput: unknown,
): Record<string, unknown> {
  return toolInput && typeof toolInput === "object"
    ? (toolInput as Record<string, unknown>)
    : {};
}

export function extToMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "text/typescript",
    tsx: "text/tsx",
    js: "text/javascript",
    jsx: "text/jsx",
    py: "text/x-python",
    rs: "text/x-rust",
    go: "text/x-go",
    java: "text/x-java",
    c: "text/x-c",
    cpp: "text/x-c++",
    cs: "text/x-csharp",
    rb: "text/x-ruby",
    sh: "text/x-sh",
    bash: "text/x-sh",
    zsh: "text/x-sh",
    json: "application/json",
    yaml: "text/yaml",
    yml: "text/yaml",
    md: "text/markdown",
    html: "text/html",
    css: "text/css",
    toml: "application/toml",
    sql: "text/x-sql",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    pdf: "application/pdf",
    txt: "text/plain",
  };
  return map[ext] ?? "text/plain";
}

/**
 * Determine whether the slash-command popover should stay open for the current
 * input value. Returns `{ open, query }`.
 *
 * When the first token after `/` is a recognized command/skill name AND there
 * is at least one argument following it, the popover closes so the user can
 * type arguments without a stale "no results" overlay.
 *
 * Commands in `keepOpenNames` (e.g. "resume") keep the popover open even with
 * arguments, because they use the popover to render argument-mode UI (session
 * picker, search results, etc.).
 *
 * Examples (assuming "skill:beads-ccpm" and "compact" are known, "resume" is keepOpen):
 *   "/sk"                              → open, query="sk"
 *   "/skill:beads-ccpm"                → open, query="skill:beads-ccpm"
 *   "/skill:beads-ccpm "               → closed (matched + has trailing space)
 *   "/skill:beads-ccpm epic-sync gm7"  → closed
 *   "/compact "                        → closed
 *   "/resume my-session"               → open, query="resume my-session"
 *   "/unknown-thing args"              → open, query="unknown-thing args"
 */
export function resolveCommandPopoverState(
  afterSlash: string,
  knownNames: Set<string>,
  keepOpenNames?: Set<string>,
): { open: boolean; query: string } {
  const spaceIdx = afterSlash.search(/\s/);
  if (spaceIdx === -1) {
    // Still typing the command name — keep popover open for filtering.
    return { open: true, query: afterSlash };
  }
  const cmdName = afterSlash.slice(0, spaceIdx).toLowerCase();
  // Some commands use the popover for argument UI (e.g. resume session picker).
  if (keepOpenNames?.has(cmdName)) {
    return { open: true, query: afterSlash };
  }
  if (knownNames.has(cmdName)) {
    // Recognised command with arguments — close the popover.
    return { open: false, query: "" };
  }
  // Unrecognised command with a space means the user has moved past the
  // command name into arguments/body text — close the popover so it
  // doesn't persist for the entire message (e.g. typing a file path
  // like "/usr/bin/python" or a non-existent command).
  return { open: false, query: "" };
}
