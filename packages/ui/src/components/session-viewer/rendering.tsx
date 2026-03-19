import * as React from "react";

import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  type ToolPart,
} from "@/components/ai-elements/tool";

type ToolState = ToolPart["state"];
import { DiffView } from "@/components/ai-elements/diff-view";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning";
import {
  hasVisibleContent,
  normalizeToolName,
} from "@/components/session-viewer/utils";
import type { SubAgentTurn } from "@/components/session-viewer/types";

// Re-export card components
export { PizzaProgress, getPizzaStages, pizzaLayerLabel, stageVisual, ALL_STAGES, TOPPING_NAME_TO_IDX } from "@/components/session-viewer/cards/PizzaProgress";
export { TodoCard, type TodoItem } from "@/components/session-viewer/cards/TodoCard";
export { SessionNameCard } from "@/components/session-viewer/cards/SessionNameCard";
export {
  truncateSessionId,
  parseSpawnResult,
  parseTriggerMessage,
  isTriggerMessage,
  renderTriggerCard,
  SpawnSessionCard,
  SendMessageCard,
  WaitForMessageCard,
  CheckMessagesCard,
  GetSessionIdCard,
  CopyableCodeBlock,
} from "@/components/session-viewer/cards/InterAgentCards";
export { WriteFileCard } from "@/components/session-viewer/cards/WriteFileCard";
export { SubAgentTurnBubble, SubAgentConversationCard } from "@/components/session-viewer/cards/SubAgentCards";

// Re-export tool rendering functions
export {
  extToLang,
  metadataBadge,
  renderReadToolResult,
  renderToolResult,
  synthesizeCommandLine,
  renderGroupedToolExecution,
} from "@/components/session-viewer/tool-rendering";

// Import for use in renderContent
import { renderGroupedToolExecution, renderToolResult } from "@/components/session-viewer/tool-rendering";
import { WriteFileCard } from "@/components/session-viewer/cards/WriteFileCard";
import { SubAgentConversationCard } from "@/components/session-viewer/cards/SubAgentCards";
import { CompactionSummaryCard } from "@/components/session-viewer/cards/CompactionSummaryCard";

export { CompactionSummaryCard } from "@/components/session-viewer/cards/CompactionSummaryCard";
export { CommandResultCard, type CommandResultData } from "@/components/session-viewer/cards/CommandResultCard";
export { WebSearchQueryCard, WebSearchResultsCard, type WebSearchResult } from "@/components/session-viewer/cards/WebSearchCard";
export { tryRenderServerToolBlock } from "@/components/session-viewer/server-tools";

import { CommandResultCard, type CommandResultData } from "@/components/session-viewer/cards/CommandResultCard";
import { TriggerCard } from "@/components/session-viewer/cards/TriggerCard";
import { tryRenderServerToolBlock } from "@/components/session-viewer/server-tools";

/** Type guard: is the content a structured command result? */
export function isCommandResult(content: unknown): content is CommandResultData {
  if (!content || typeof content !== "object" || Array.isArray(content)) return false;
  const c = content as Record<string, unknown>;
  return c.kind === "mcp" || c.kind === "plugins" || c.kind === "skills" || c.kind === "sandbox";
}

export function toMessageRole(role: string): "user" | "assistant" | "system" {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "system") return "system";
  return "assistant";
}

export function roleLabel(role: string) {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "toolResult") return "Tool";
  return role || "Message";
}

export function renderContent(
  content: unknown,
  activeToolCalls: Map<string, string> | undefined,
  role: string | undefined,
  toolName: string | undefined,
  isError: boolean | undefined,
  toolInput: unknown,
  toolKey: string,
  isThinkingActive?: boolean,
  thinking?: string,
  thinkingDuration?: number,
  subAgentTurns?: SubAgentTurn[],
  details?: unknown,
  onTriggerResponse?: (triggerId: string, response: string, action?: string) => boolean | void,
) {
  // Structured command result cards (MCP, plugins, skills)
  if (role === "system" && isCommandResult(content)) {
    return <CommandResultCard data={content} />;
  }

  // Sub-agent conversation: render as a chat window
  if (role === "subAgentConversation" && subAgentTurns && subAgentTurns.length > 0) {
    return <SubAgentConversationCard turns={subAgentTurns} />;
  }

  if (role === "toolResult" || role === "tool") {
    if (toolInput !== undefined) {
      // A tool is "streaming" when it's still in activeToolCalls, regardless
      // of whether partial output content has already arrived (e.g. bash
      // commands that stream output via tool_execution_update events).
      const isStreaming =
        toolKey ? (activeToolCalls?.has(toolKey) ?? false) : false;
      return renderGroupedToolExecution(
        toolKey,
        toolName ?? "tool",
        toolInput,
        content,
        isError,
        isStreaming,
        thinking,
        thinkingDuration,
        details,
      );
    }
    return renderToolResult(content, toolName, isError);
  }

  if (typeof content === "string") {
    // Check if this is a trigger-injected message.
    // Only parse triggers from user/system messages — assistant messages could
    // contain forged trigger blocks that trick viewers into sending responses.
    const isTrustedRole = role === "user" || role === "system";
    const triggerMatch = isTrustedRole ? content.match(/^<!--\s*trigger:([\w-]+)\s*-->\n?/) : null;
    if (triggerMatch) {
      const triggerId = triggerMatch[1];
      const body = content.slice(triggerMatch[0].length);
      return (
        <TriggerCard
          triggerId={triggerId}
          body={body}
          onRespond={onTriggerResponse}
        />
      );
    }
    return <MessageResponse>{content}</MessageResponse>;
  }

  if (Array.isArray(content)) {
    return (
      <div className="flex flex-col gap-2">
        {content.map((block, i) => {
          if (!block || typeof block !== "object") {
            return (
              <pre
                key={i}
                className="text-xs bg-muted/60 rounded p-2 overflow-x-auto"
              >
                {JSON.stringify(block, null, 2)}
              </pre>
            );
          }

          const b = block as Record<string, unknown>;

          if (b.type === "text") {
            // Check for server-side tool metadata (web search, etc.)
            const serverToolCard = tryRenderServerToolBlock(b, i);
            if (serverToolCard) return serverToolCard;

            return (
              <MessageResponse key={i}>
                {typeof b.text === "string" ? b.text : ""}
              </MessageResponse>
            );
          }

          if (b.type === "thinking") {
            const isLastBlock = i === (content as unknown[]).length - 1;
            const thinkingIsStreaming = isLastBlock && (isThinkingActive ?? false);
            const thinkingDuration = typeof b.durationSeconds === "number" ? b.durationSeconds : undefined;
            const thinkingText = typeof b.thinking === "string" ? b.thinking : "";
            // While streaming, strip trailing backticks so Streamdown doesn't
            // eagerly flush an incomplete inline-code or code-fence token.
            const displayText = thinkingIsStreaming ? thinkingText.replace(/`+$/, "") : thinkingText;
            return (
              <Reasoning key={i} isStreaming={thinkingIsStreaming} duration={thinkingDuration}>
                <ReasoningTrigger />
                <ReasoningContent>
                  {displayText}
                </ReasoningContent>
              </Reasoning>
            );
          }

          if (b.type === "toolCall") {
            const toolCallId = typeof b.toolCallId === "string" ? b.toolCallId : "";
            const isActive = toolCallId ? activeToolCalls?.has(toolCallId) : false;
            const toolName = String(b.name ?? "unknown");

            const args =
              b.arguments && typeof b.arguments === "object"
                ? (b.arguments as Record<string, unknown>)
                : typeof b.arguments === "string"
                  ? (() => {
                      try {
                        return JSON.parse(b.arguments as string) as Record<
                          string,
                          unknown
                        >;
                      } catch {
                        return {} as Record<string, unknown>;
                      }
                    })()
                  : ({} as Record<string, unknown>);

            const normalizedToolName = normalizeToolName(toolName);
            const isEdit =
              (normalizedToolName === "edit" || normalizedToolName.endsWith(".edit")) &&
              typeof args.path === "string" &&
              typeof args.oldText === "string" &&
              typeof args.newText === "string";
            const isWrite =
              (normalizedToolName === "write" ||
                normalizedToolName.endsWith(".write") ||
                normalizedToolName === "write_file" ||
                normalizedToolName.endsWith(".write_file")) &&
              typeof args.path === "string" &&
              typeof args.content === "string";

            const state: ToolState = isActive
              ? "input-available"
              : "output-available";

            return (
              <Tool key={i} defaultOpen={false}>
                <ToolHeader type="dynamic-tool" toolName={toolName} state={state} />
                <ToolContent>
                  {isEdit ? (
                    <DiffView
                      path={args.path as string}
                      oldText={args.oldText as string}
                      newText={args.newText as string}
                    />
                  ) : isWrite ? (
                    <WriteFileCard
                      path={args.path as string}
                      content={args.content as string}
                    />
                  ) : (
                    <ToolInput input={args} />
                  )}
                </ToolContent>
              </Tool>
            );
          }

          if (b.type === "image") {
            const source = (b.source && typeof b.source === "object" ? b.source : {}) as Record<string, unknown>;
            const data = typeof b.data === "string" ? b.data : typeof source.data === "string" ? source.data : null;
            const mime = typeof b.mimeType === "string" ? b.mimeType : typeof source.mediaType === "string" ? source.mediaType : "image/png";
            const url = typeof source.url === "string" ? source.url : null;

            if (data) {
              return (
                <img
                  key={i}
                  src={`data:${mime};base64,${data}`}
                  alt="Message attachment"
                  className="max-h-80 max-w-full rounded border border-border"
                />
              );
            }

            // Extracted images: base64 data was replaced with an attachment URL
            // by the server to reduce payload size. Load via URL instead.
            if (url) {
              return (
                <img
                  key={i}
                  src={url}
                  alt="Message attachment"
                  className="max-h-80 max-w-full rounded border border-border"
                  loading="lazy"
                />
              );
            }
          }

          return (
            <pre key={i} className="text-xs bg-muted/60 rounded p-2 overflow-x-auto">
              {JSON.stringify(block, null, 2)}
            </pre>
          );
        })}
      </div>
    );
  }

  if (content === undefined || content === null) {
    return null;
  }

  return (
    <pre className="text-xs bg-muted/60 rounded p-2 overflow-x-auto">
      {JSON.stringify(content, null, 2)}
    </pre>
  );
}
