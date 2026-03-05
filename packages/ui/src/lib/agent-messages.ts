import type { RelayMessage } from "@/components/session-viewer/types";

// Re-export the AgentMessage type from the component
export type { AgentMessage } from "@/components/AgentMessagesPanel";
import type { AgentMessage } from "@/components/AgentMessagesPanel";

/**
 * Normalize tool name — strip MCP prefix, lowercase.
 */
function bareToolName(toolName: string | undefined): string {
  if (!toolName) return "";
  const norm = toolName.toLowerCase().replace(/_/g, "_");
  const parts = norm.split(".");
  return parts[parts.length - 1] ?? norm;
}

/**
 * Extract visible text from tool content (string or content blocks).
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") return b.text;
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

/**
 * Extract structured inter-agent messages from the relay message stream.
 *
 * Scans for send_message, wait_for_message, and check_messages tool calls
 * and their results, returning them as a flat chronological list of
 * AgentMessage objects suitable for the AgentMessagesPanel.
 */
export function extractAgentMessages(
  messages: RelayMessage[],
  currentSessionId: string,
): AgentMessage[] {
  const result: AgentMessage[] = [];

  for (const msg of messages) {
    if (msg.role !== "tool" && msg.role !== "toolResult") continue;

    const bare = bareToolName(msg.toolName);
    if (!bare) continue;

    const input =
      msg.toolInput && typeof msg.toolInput === "object"
        ? (msg.toolInput as Record<string, unknown>)
        : {};
    const resultText = extractText(msg.content);
    const ts = msg.timestamp ?? Date.now();

    if (bare === "send_message") {
      const targetSessionId =
        typeof input.sessionId === "string" ? input.sessionId : "unknown";
      const message = typeof input.message === "string" ? input.message : "";
      if (!message) continue;

      // Check if this is a completion message (heuristic: starts with "DONE:" or "COMPLETE:")
      const isCompletion =
        /^(DONE|COMPLETE|FINISHED|RESULT)[:\s]/i.test(message.trim());

      result.push({
        id: `sent-${msg.key}`,
        fromSessionId: currentSessionId,
        fromSessionName: null, // current session
        toSessionId: targetSessionId,
        toSessionName: null,
        message,
        timestamp: ts,
        direction: "sent",
        isCompletion,
      });
      continue;
    }

    if (bare === "wait_for_message") {
      // Only extract messages that were actually received
      if (!resultText.startsWith("Message from session")) continue;

      const match = resultText.match(
        /^Message from session (.+?):\n\n([\s\S]*)$/,
      );
      if (!match) continue;

      const fromSessionId = match[1]!;
      const message = match[2]!;
      const isCompletion =
        /^(DONE|COMPLETE|FINISHED|RESULT)[:\s]/i.test(message.trim());

      result.push({
        id: `received-${msg.key}`,
        fromSessionId,
        fromSessionName: null,
        toSessionId: currentSessionId,
        toSessionName: null,
        message,
        timestamp: ts,
        direction: "received",
        isCompletion,
      });
      continue;
    }

    if (bare === "check_messages") {
      if (!resultText || resultText === "No pending messages.") continue;

      // Parse multiple messages from check_messages result
      const body = resultText.replace(/^\d+ message\(s\) received:\n\n/, "");
      const parts = body.split(/\n\n(?=\[)/);
      for (const part of parts) {
        const match = part.match(/^\[(.+?)\]\s([\s\S]*)$/);
        if (!match) continue;

        const fromSessionId = match[1]!;
        const message = match[2]!;
        const isCompletion =
          /^(DONE|COMPLETE|FINISHED|RESULT)[:\s]/i.test(message.trim());

        result.push({
          id: `checked-${msg.key}-${fromSessionId}`,
          fromSessionId,
          fromSessionName: null,
          toSessionId: currentSessionId,
          toSessionName: null,
          message,
          timestamp: ts,
          direction: "received",
          isCompletion,
        });
      }
    }
  }

  // Sort chronologically
  result.sort((a, b) => a.timestamp - b.timestamp);

  return result;
}
