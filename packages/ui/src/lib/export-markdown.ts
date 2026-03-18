/**
 * Rich markdown formatter for exporting conversation sessions.
 *
 * Takes raw RelayMessage[] and produces well-structured markdown with proper
 * rendering of tool calls, thinking blocks, sub-agent conversations, etc.
 */

import type { RelayMessage, SubAgentTurn } from "@/components/session-viewer/types";

/** Maximum characters for tool output before truncation. */
const TOOL_OUTPUT_MAX = 5000;

/** Stringify unknown content into a readable string. */
function contentToString(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  // Anthropic-style content blocks: [{type:"text", text:"..."}, ...]
  if (Array.isArray(content)) {
    const texts = content
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === "object" &&
          block !== null &&
          "text" in block &&
          typeof (block as Record<string, unknown>).text === "string",
      )
      .map((block) => block.text);
    if (texts.length > 0) return texts.join("\n\n");
    // Fallback: stringify the array
    return "```json\n" + JSON.stringify(content, null, 2) + "\n```";
  }
  if (typeof content === "object") {
    return "```json\n" + JSON.stringify(content, null, 2) + "\n```";
  }
  return String(content);
}

/** Pretty-print tool input as a JSON code block. */
function formatToolInput(input: unknown): string {
  if (input == null) return "";
  const json =
    typeof input === "string" ? input : JSON.stringify(input, null, 2);
  return "**Input:**\n```json\n" + json + "\n```";
}

/** Format tool output, truncating if too long. */
function formatToolOutput(content: unknown): string {
  if (content == null) return "";
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  if (!text) return "";
  const truncated =
    text.length > TOOL_OUTPUT_MAX
      ? text.slice(0, TOOL_OUTPUT_MAX) +
        `\n\n[truncated — ${text.length} chars total]`
      : text;
  return "**Output:**\n```\n" + truncated + "\n```";
}

/** Render a single sub-agent turn. */
function formatSubAgentTurn(turn: SubAgentTurn): string {
  switch (turn.type) {
    case "sent":
      return `> **→ Sent** to ${turn.sessionId}:\n> ${turn.message.split("\n").join("\n> ")}`;
    case "received":
      return `> **← Received** from ${turn.fromSessionId}:\n> ${turn.message.split("\n").join("\n> ")}`;
    case "waiting":
      if (turn.isTimedOut) return "> **⏳ Timed out** waiting for response";
      if (turn.isCancelled) return "> **❌ Cancelled** waiting for response";
      return "> **⏳ Waiting** for response...";
    case "check": {
      if (turn.isEmpty) return "> **📭 No messages** in queue";
      return turn.messages
        .map(
          (m) =>
            `> **← Message** from ${m.fromSessionId}:\n> ${m.message.split("\n").join("\n> ")}`,
        )
        .join("\n\n");
    }
  }
}

/** Format a single RelayMessage into markdown. */
function formatMessage(message: RelayMessage): string | null {
  const { role } = message;

  // ── User ──
  if (role === "user") {
    const text = contentToString(message.content);
    if (!text) return null;
    return `## 🧑 User\n\n${text}`;
  }

  // ── Assistant ──
  if (role === "assistant") {
    const parts: string[] = [];
    parts.push("## 🤖 Assistant");

    // Thinking block
    if (message.thinking) {
      const duration = message.thinkingDuration
        ? ` (${message.thinkingDuration}ms)`
        : "";
      parts.push(
        `<details>\n<summary>💭 Thinking${duration}</summary>\n\n${message.thinking}\n\n</details>`,
      );
    }

    const text = contentToString(message.content);
    if (text) parts.push(text);

    // Error
    if (message.stopReason === "error" && message.errorMessage) {
      parts.push(`> ⚠️ **Error:** ${message.errorMessage}`);
    }

    return parts.length > 1 ? parts.join("\n\n") : null;
  }

  // ── Tool call / Tool result ──
  if (role === "tool" || role === "toolResult") {
    const name = message.toolName || "Unknown tool";
    const parts: string[] = [`### 🔧 ${name}`];

    if (message.toolInput != null) {
      const input = formatToolInput(message.toolInput);
      if (input) parts.push(input);
    }

    const output = formatToolOutput(message.content);
    if (output) parts.push(output);

    if (message.isError && message.content) {
      parts.push(`> ⚠️ Tool returned an error`);
    }

    return parts.length > 1 ? parts.join("\n\n") : null;
  }

  // ── Compaction summary ──
  if (role === "compactionSummary" && message.summary) {
    const tokens = message.tokensBefore
      ? ` (${message.tokensBefore.toLocaleString()} tokens)`
      : "";
    return `---\n\n> 📦 **Context compacted**${tokens}\n>\n> ${message.summary.split("\n").join("\n> ")}\n\n---`;
  }

  // ── Branch summary ──
  if (role === "branchSummary" && message.summary) {
    return `---\n\n> 🌿 **Branch summary**\n>\n> ${message.summary.split("\n").join("\n> ")}\n\n---`;
  }

  // ── Sub-agent conversation ──
  if (role === "subAgentConversation" && message.subAgentTurns?.length) {
    const turns = message.subAgentTurns.map(formatSubAgentTurn).join("\n\n");
    return `#### 🤝 Sub-agent Conversation\n\n${turns}`;
  }

  // ── System messages ──
  if (role === "system") {
    const text = contentToString(message.content);
    if (!text) return null;
    return `> **System:** ${text.split("\n").join("\n> ")}`;
  }

  // ── Fallback: unknown roles with content ──
  const fallback = contentToString(message.content);
  if (fallback) return `### ${role}\n\n${fallback}`;

  return null;
}

/**
 * Convert an array of RelayMessages into a well-formatted markdown document.
 */
export function exportToMarkdown(messages: RelayMessage[]): string {
  const sections = messages
    .map(formatMessage)
    .filter((s): s is string => s !== null);
  return sections.join("\n\n") + "\n";
}
