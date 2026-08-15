/**
 * Human-language summaries of tool calls, for modes that render activity
 * instead of terminal output (ServiceModeUi.toolRendering === "activity").
 *
 * A knowledge-work mode should say "Created report.md", not show a bash block.
 * Pure functions so they can be tested without mounting the message tree.
 */

import { normalizeToolName } from "@/components/session-viewer/utils";

export interface ActivitySummary {
  /** Lucide icon name for the activity line. */
  icon: string;
  /** Human-language label, e.g. "Created report.md". */
  label: string;
  /** Optional secondary text, e.g. the search query. */
  detail?: string;
}

/** Strip an MCP/plugin namespace so "mcp__x__read" and "read" summarize alike. */
function baseToolName(toolName?: string): string {
  const norm = normalizeToolName(toolName);
  const afterDot = norm.includes(".") ? norm.slice(norm.lastIndexOf(".") + 1) : norm;
  return afterDot.includes("__") ? afterDot.slice(afterDot.lastIndexOf("__") + 2) : afterDot;
}

/** Best-effort object view of a tool's input, which may arrive as a JSON string. */
function inputArgs(toolInput: unknown): Record<string, unknown> {
  if (toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)) {
    return toolInput as Record<string, unknown>;
  }
  if (typeof toolInput === "string") {
    try {
      const parsed = JSON.parse(toolInput);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON — no args to read.
    }
  }
  return {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Trailing path segment, so activity lines read as file names not full paths. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Truncate to a length that fits one line without wrapping on mobile. */
function clamp(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Host of a URL, or the raw string when it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Summarize one tool call as an activity line.
 *
 * Falls back to a humanized tool name so an unknown tool (a new MCP server,
 * a plugin) still renders as readable activity rather than disappearing.
 */
export function summarizeToolActivity(
  toolName: string | undefined,
  toolInput: unknown,
  isError?: boolean,
): ActivitySummary {
  const name = baseToolName(toolName);
  const args = inputArgs(toolInput);
  const path = str(args.file_path) ?? str(args.path);
  const file = path ? baseName(path) : null;

  switch (name) {
    case "write":
    case "write_file":
      return { icon: "file-plus", label: file ? `Created ${file}` : "Created a file" };
    case "edit":
      return { icon: "file-pen", label: file ? `Edited ${file}` : "Edited a file" };
    case "read":
      return { icon: "file-text", label: file ? `Read ${file}` : "Read a file" };
    case "bash":
    case "shell": {
      const command = str(args.command);
      const title = str(args.title);
      return { icon: "terminal", label: title ?? "Ran a command", detail: command ? clamp(command) : undefined };
    }
    case "web_search": {
      const query = str(args.query);
      return { icon: "globe", label: query ? `Searched the web for "${clamp(query, 60)}"` : "Searched the web" };
    }
    case "web_fetch": {
      const url = str(args.url);
      return { icon: "globe", label: url ? `Read ${hostOf(url)}` : "Read a web page" };
    }
    case "search":
    case "grep":
    case "glob": {
      const query = str(args.query) ?? str(args.pattern);
      return { icon: "search", label: query ? `Searched for "${clamp(query, 60)}"` : "Searched files" };
    }
    case "session_search": {
      const query = str(args.query);
      return { icon: "history", label: query ? `Searched history for "${clamp(query, 60)}"` : "Searched history" };
    }
    case "update_todo":
      return { icon: "list-checks", label: "Updated the plan" };
    case "set_session_name":
      return { icon: "pencil", label: "Renamed this task" };
    case "subagent":
    case "task":
      return { icon: "users", label: "Delegated to a helper" };
    case "spawn_session":
      return { icon: "users", label: "Started a linked session" };
    case "run_workflow":
    case "run_saved_workflow":
      return { icon: "workflow", label: "Ran a workflow" };
    case "askuserquestion":
      return { icon: "circle-question-mark", label: "Asked a question" };
    case "plan_mode":
    case "toggle_plan_mode":
      return { icon: "clipboard-list", label: "Made a plan" };
    case "memory_save":
    case "memory_append":
    case "memory_edit":
      return { icon: "brain", label: "Saved a note to memory" };
    case "memory_read":
    case "memory_list":
      return { icon: "brain", label: "Checked memory" };
    case "create_tunnel":
    case "list_tunnels":
    case "close_tunnel":
      return { icon: "link", label: "Managed a shared link" };
    case "get_current_time":
      return { icon: "clock", label: "Checked the time" };
    default: {
      // "capture_idea" -> "Capture idea"; keeps unknown tools legible.
      const words = name.replace(/[_-]+/g, " ").trim();
      const label = words ? words.charAt(0).toUpperCase() + words.slice(1) : "Did something";
      return { icon: isError ? "circle-alert" : "sparkles", label };
    }
  }
}
