/**
 * Rich markdown formatter for exporting conversation sessions.
 *
 * Takes raw RelayMessage[] and produces well-structured markdown with proper
 * rendering of tool calls, thinking blocks, sub-agent conversations, etc.
 */

import type { RelayMessage, SubAgentTurn } from "@/components/session-viewer/types";

/** Maximum characters for tool output before truncation. */
const TOOL_OUTPUT_MAX = 5000;

/** Extract web-search metadata from an Anthropic content block, if present. */
function extractWebSearch(block: Record<string, unknown>): string | null {
  // Server tool use (query)
  if (block._serverToolUse) {
    const meta = block._serverToolUse as { input?: { query?: string } };
    const query = meta.input?.query;
    if (query) return `🔍 **Web search:** ${query}`;
  }
  // Web search results
  if (block._webSearchResult) {
    const meta = block._webSearchResult as {
      content?: Array<{ type: string; title?: string; url?: string }>;
    };
    const results = Array.isArray(meta.content)
      ? meta.content.filter(
          (r) =>
            r.type === "web_search_result" &&
            typeof r.title === "string" &&
            typeof r.url === "string",
        )
      : [];
    if (results.length > 0) {
      const lines = results.map((r) => {
        const title = (r.title ?? "").replace(/\\/g, "\\\\").replace(/[\[\]]/g, "\\$&");
        const url = (r.url ?? "").replace(/\\/g, "\\\\").replace(/[()]/g, "\\$&");
        return `- [${title}](${url})`;
      });
      return `📎 **Search results:**\n${lines.join("\n")}`;
    }
  }
  return null;
}

/** Strip `<!-- trigger:ID -->` prefixes injected by linked-session triggers. */
const TRIGGER_PREFIX_RE = /^<!--\s*trigger:[\w-]+\s*-->\n?/;

/** Stringify unknown content into a readable string. */
function contentToString(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content.replace(TRIGGER_PREFIX_RE, "");
  // Anthropic-style content blocks: [{type:"text", text:"..."}, {type:"thinking", thinking:"..."}, ...]
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;

      // Inline thinking blocks (not yet hoisted to message.thinking)
      if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) {
        parts.push(
          `<details>\n<summary>💭 Thinking</summary>\n\n${b.thinking}\n\n</details>`,
        );
        continue;
      }

      // Web search metadata on text blocks
      const webSearch = extractWebSearch(b);
      if (webSearch) {
        parts.push(webSearch);
        // Also include any text content on the same block
        if (typeof b.text === "string" && b.text) parts.push(b.text);
        continue;
      }

      // Image blocks — preserve a reference since we can't inline binary data
      if (b.type === "image") {
        const src = typeof b.source === "object" && b.source !== null
          ? (b.source as Record<string, unknown>)
          : null;
        if (src?.type === "url" && typeof src.url === "string") {
          parts.push(`![image](${src.url})`);
        } else {
          parts.push("🖼️ *[Image attachment]*");
        }
        continue;
      }

      // Regular text blocks
      if (typeof b.text === "string" && b.text) {
        parts.push(b.text);
      }
    }
    if (parts.length > 0) return parts.join("\n\n");
    // Fallback: stringify the array if no recognized blocks
    return "```json\n" + JSON.stringify(content, null, 2) + "\n```";
  }
  if (typeof content === "object") {
    return "```json\n" + JSON.stringify(content, null, 2) + "\n```";
  }
  return String(content);
}

/**
 * Pick a fence delimiter that doesn't collide with content.
 * If the text contains ```, use a longer fence (````` or more).
 */
function safeFence(text: string, lang = ""): string {
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** Pretty-print tool input as a JSON code block. */
function formatToolInput(input: unknown): string {
  if (input == null) return "";
  const json =
    typeof input === "string" ? input : JSON.stringify(input, null, 2);
  return "**Input:**\n" + safeFence(json, "json");
}

/** Extract text from tool content (Anthropic-style arrays or plain strings). */
function toolContentToString(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  // Anthropic-style content blocks: [{type:"text", text:"..."}, ...]
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") parts.push(b.text);
      else if (typeof b.content === "string") parts.push(b.content);
    }
    if (parts.length > 0) return parts.join("\n\n");
  }
  // Object with .text or .content property (common for MCP tool results and streaming wrappers)
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    // .content can be a string or a nested array (streaming wrapper shape: { content, details })
    if (obj.content != null) return toolContentToString(obj.content);
  }
  // Fallback: JSON stringify
  return JSON.stringify(content, null, 2);
}

/** Format tool output, truncating if too long. */
function formatToolOutput(content: unknown): string {
  if (content == null) return "";
  const text = toolContentToString(content);
  if (!text) return "";
  const truncated =
    text.length > TOOL_OUTPUT_MAX
      ? text.slice(0, TOOL_OUTPUT_MAX) +
        `\n\n[truncated — ${text.length} chars total]`
      : text;
  return "**Output:**\n" + safeFence(truncated);
}

/** Render a single sub-agent turn. */
function formatSubAgentTurn(turn: SubAgentTurn): string {
  switch (turn.type) {
    case "sent":
      if (turn.isError) {
        return `> **⚠️ Send failed** to ${turn.sessionId}:\n> ${turn.message.split("\n").join("\n> ")}`;
      }
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
        ? ` (${message.thinkingDuration}s)`
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

    // Thinking hoisted onto tool messages by grouping
    if (message.thinking) {
      const duration = message.thinkingDuration
        ? ` (${message.thinkingDuration}s)`
        : "";
      parts.push(
        `<details>\n<summary>💭 Thinking${duration}</summary>\n\n${message.thinking}\n\n</details>`,
      );
    }

    if (message.toolInput != null) {
      const input = formatToolInput(message.toolInput);
      if (input) parts.push(input);
    }

    const output = formatToolOutput(message.content);
    if (output) parts.push(output);

    if (message.isError && message.content) {
      parts.push(`> ⚠️ Tool returned an error`);
    }

    // Subagent details — extract per-agent task/response pairs
    if (message.details && typeof message.details === "object") {
      const det = message.details as {
        mode?: string;
        results?: Array<{
          agent?: string;
          task?: string;
          messages?: Array<{ role: string; content: unknown }>;
          exitCode?: number;
          errorMessage?: string;
        }>;
      };
      if (Array.isArray(det.results) && det.results.length > 0) {
        for (const r of det.results) {
          const agentName = r.agent || "subagent";
          const lines: string[] = [`#### 🤖 ${agentName}`];
          if (r.task) lines.push(`**Task:** ${r.task}`);
          // Extract last assistant message as the response
          const lastAssistant = r.messages
            ?.filter((m) => m.role === "assistant")
            .pop();
          if (lastAssistant) {
            const responseText = contentToString(lastAssistant.content);
            if (responseText) lines.push(`**Response:**\n${responseText}`);
          }
          if (r.errorMessage) lines.push(`> ⚠️ ${r.errorMessage}`);
          parts.push(lines.join("\n\n"));
        }
      }
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
    // If content is structured (contains code fences), use a heading instead
    // of blockquote to avoid broken markdown
    if (text.includes("```")) {
      return `### ⚙️ System\n\n${text}`;
    }
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
