/**
 * Translates Claude Code CLI NDJSON output lines into PizzaPi relay events.
 */

/** Tool names that Claude Code uses for subagent invocations.
 *  "Task" is the older name, "Agent" is the current SDK name.
 *  Pi uses "subagent". All are recognized for lifecycle tracking. */
export const SUBAGENT_TOOL_NAMES = new Set(["Task", "Agent", "subagent"]);

/** Info about a tool_use block extracted from an assistant message. */
export interface ToolCallInfo {
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
}

export interface TranslationResult {
  kind:
    | "control_request"   // needs a response on stdin
    | "control_response"  // bridge sent this, echoed back (ignore)
    | "session_init"      // system/init — carry session metadata
    | "ask_user_question" // AskUserQuestion tool — needs UI interaction
    | "relay_event"       // normal relay event to forward
    | "unknown";          // unrecognised / malformed
  relayEvent?: Record<string, unknown>;
  /** When one NDJSON line produces multiple relay events (e.g. a user message
   *  containing several tool_result blocks), use this array instead of
   *  `relayEvent`. The bridge iterates over all entries and forwards each one. */
  relayEvents?: Array<Record<string, unknown>>;
  // control_request fields
  controlRequestId?: string;
  toolName?: string;
  toolInput?: unknown;
  // session_init fields
  sessionId?: string;
  model?: string;
  cwd?: string;
  // ask_user_question fields
  toolCallId?: string;
  questions?: Array<{ question: string; options: string[]; type?: string }>;
  // todoWrite side-effect
  todoList?: Array<{ id: string; text: string; content: string; status: string; priority: string }>;
  // set_session_name side-effect
  sessionName?: string;
  // token usage from result events
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number };
  /** Tool calls extracted from assistant messages — used by the bridge to
   *  track pending tool executions and emit synthetic tool_execution_start/end
   *  events. Excludes side-effect-only tools (TodoWrite, set_session_name)
   *  and AskUserQuestion (which has its own handling path). */
  toolCalls?: ToolCallInfo[];
  /** Tool call IDs extracted from tool_result blocks in user messages — used
   *  by the bridge to emit synthetic tool_execution_end events. */
  toolResultIds?: string[];
  /** When non-null, this event belongs to a subagent invocation (Agent/Task
   *  tool) and should not appear in the parent conversation.  The value is
   *  the tool_use_id of the Agent/Task tool call that spawned the subagent.
   *  Claude Code sets `parent_tool_use_id` on every NDJSON message; top-level
   *  messages have it as `null`. */
  parentToolUseId?: string;
}

export function translateNdjsonLine(line: string): TranslationResult {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    return { kind: "unknown" };
  }

  const type = msg.type;

  // ── Subagent nesting indicator ────────────────────────────────────────
  // Claude Code sets `parent_tool_use_id` on every NDJSON message.
  // - `null` → top-level (parent conversation)
  // - string → subagent-internal (belongs to Agent/Task tool with that id)
  const rawParent = msg.parent_tool_use_id;
  const parentToolUseId = typeof rawParent === "string" ? rawParent : undefined;

  // ── Control protocol frames ───────────────────────────────────────────
  if (type === "control_request") {
    const req = msg.request as Record<string, unknown> | undefined;
    return {
      kind: "control_request",
      controlRequestId: typeof msg.request_id === "string" ? msg.request_id : undefined,
      toolName: typeof req?.tool_name === "string" ? req.tool_name : undefined,
      toolInput: req?.input,
    };
  }

  if (type === "control_response") {
    return { kind: "control_response" };
  }

  // ── System init ───────────────────────────────────────────────────────
  if (type === "system" && msg.subtype === "init") {
    return {
      kind: "session_init",
      sessionId: typeof msg.session_id === "string" ? msg.session_id : undefined,
      model: typeof msg.model === "string" ? msg.model : undefined,
      cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
    };
  }

  // ── Assistant messages ────────────────────────────────────────────────
  if (type === "assistant") {
    const message = msg.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content as unknown[] : [];

    // Side-effect extraction
    let todoList: TranslationResult["todoList"] | undefined;
    let sessionName: string | undefined;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use") continue;

      // AskUserQuestion — needs special handling (returns immediately)
      if (b.name === "AskUserQuestion") {
        const input = b.input as Record<string, unknown> | undefined;
        const rawQs = Array.isArray(input?.questions) ? input!.questions as unknown[] : [];
        const questions = rawQs
          .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
          .map((q) => ({
            question: typeof q.question === "string" ? q.question : "",
            options: Array.isArray(q.options) ? (q.options as unknown[]).filter((o): o is string => typeof o === "string") : [],
            type: typeof q.type === "string" ? q.type : "radio",
          }));
        // Include relayEvent so the bridge can save the assistant message to
        // history before presenting the question.  Without this the AskUserQuestion
        // turn is silently dropped, which breaks reconnect snapshots.
        return {
          kind: "ask_user_question",
          toolCallId: typeof b.id === "string" ? b.id : undefined,
          questions,
          relayEvent: { type: "message_update", role: "assistant", message },
        };
      }

      // TodoWrite — extract todo list as a side-effect
      if (b.name === "TodoWrite" || b.name === "update_todo") {
        const input = b.input as Record<string, unknown> | undefined;
        const rawTodos = Array.isArray(input?.todos) ? input!.todos as unknown[] : [];
        todoList = rawTodos
          .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
          .map((t) => {
            const text = String(t.text ?? t.content ?? "");
            const rawStatus = String(t.status ?? "pending").trim();
            const status = rawStatus === "in_progress" || rawStatus === "done" || rawStatus === "cancelled"
              ? rawStatus
              : "pending";
            return {
              id: String(t.id ?? ""),
              text,
              content: text,
              status,
              priority: String(t.priority ?? "medium"),
            };
          });
      }

      // set_session_name — extract session name as a side-effect
      if (b.name === "set_session_name") {
        const input = b.input as Record<string, unknown> | undefined;
        const name = typeof input?.name === "string" ? input.name.trim() : "";
        if (name) sessionName = name;
      }
    }

    // Normalize Claude tool_use blocks into PizzaPi toolCall blocks so the
    // viewer's grouping/rendering path (which expects type:"toolCall" with
    // toolCallId/arguments) works correctly.
    //
    // Also collect ToolCallInfo for each tool_use that represents a real tool
    // execution (not side-effect-only tools or AskUserQuestion).
    const toolCalls: ToolCallInfo[] = [];
    const SIDE_EFFECT_TOOLS = new Set(["TodoWrite", "update_todo", "set_session_name"]);

    const normalizedContent = content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use") return block;

      const toolCallId = typeof b.id === "string" ? b.id : undefined;
      const name = typeof b.name === "string" ? b.name : undefined;

      // Collect tool call info for tools that will actually execute
      // (exclude side-effect-only tools and AskUserQuestion which has its own path)
      if (toolCallId && name && !SIDE_EFFECT_TOOLS.has(name) && name !== "AskUserQuestion") {
        toolCalls.push({ toolCallId, toolName: name, toolInput: b.input });
      }

      return {
        type: "toolCall",
        toolCallId,
        name,
        arguments: b.input != null ? JSON.stringify(b.input) : undefined,
      };
    });
    const normalizedMessage = { ...message, content: normalizedContent };

    const result: TranslationResult = {
      kind: "relay_event",
      relayEvent: { type: "message_update", role: "assistant", message: normalizedMessage },
      parentToolUseId,
    };
    if (todoList) result.todoList = todoList;
    if (sessionName) result.sessionName = sessionName;
    if (toolCalls.length > 0) result.toolCalls = toolCalls;
    return result;
  }

  // ── User messages (replayed with --replay-user-messages) ──────────────
  //
  // Claude Code sends tool results inside user messages:
  //   { type: "user", message: { role: "user", content: [{ type: "tool_result", ... }] } }
  //
  // The UI expects tool results as separate relay events with role "toolResult"
  // and a top-level toolCallId field — not wrapped in a generic user message.
  // Detect tool_result blocks in the content and split them into individual events.
  if (type === "user") {
    const message = msg.message as Record<string, unknown> | undefined;
    const rawContent = Array.isArray(message?.content)
      ? (message!.content as unknown[])
      : null;

    // No content array — pass through as a plain user message
    if (!rawContent) {
      return {
        kind: "relay_event",
        relayEvent: { type: "message_update", role: "user", message },
        parentToolUseId,
      };
    }

    // Partition content into tool_result blocks and everything else
    const toolResultBlocks: Record<string, unknown>[] = [];
    const otherBlocks: unknown[] = [];
    for (const block of rawContent) {
      if (block && typeof block === "object" &&
          (block as Record<string, unknown>).type === "tool_result") {
        toolResultBlocks.push(block as Record<string, unknown>);
      } else {
        otherBlocks.push(block);
      }
    }

    // No tool_result blocks — pass through as a plain user message
    if (toolResultBlocks.length === 0) {
      return {
        kind: "relay_event",
        relayEvent: { type: "message_update", role: "user", message },
        parentToolUseId,
      };
    }

    // Build one relay event per tool_result block, plus one user event for any
    // remaining non-tool_result blocks.
    const events: Array<Record<string, unknown>> = [];
    const toolResultIds: string[] = [];

    for (const block of toolResultBlocks) {
      const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
      // content can be a string, an array of content blocks, or absent
      const blockContent = block.content ?? "";
      const isError = block.is_error === true;

      if (toolCallId) toolResultIds.push(toolCallId);

      events.push({
        type: "message_update",
        message: {
          role: "toolResult",
          ...(toolCallId !== undefined ? { toolCallId } : {}),
          content: blockContent,
          isError,
        },
      });
    }

    // Remaining non-tool_result content (e.g. text blocks) → plain user message
    if (otherBlocks.length > 0) {
      events.push({
        type: "message_update",
        message: {
          role: "user",
          content: otherBlocks,
        },
      });
    }

    const translationResult: TranslationResult = events.length === 1
      ? { kind: "relay_event", relayEvent: events[0], parentToolUseId }
      : { kind: "relay_event", relayEvents: events, parentToolUseId };

    if (toolResultIds.length > 0) translationResult.toolResultIds = toolResultIds;
    return translationResult;
  }

  // ── Result (turn complete) ────────────────────────────────────────────
  if (type === "result") {
    // Extract token usage
    let tokenUsage: TranslationResult["tokenUsage"] | undefined;
    const usage = msg.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage === "object") {
      const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
      const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
      tokenUsage = { inputTokens, outputTokens };
      if (typeof usage.cache_creation_input_tokens === "number") tokenUsage.cacheCreationInputTokens = usage.cache_creation_input_tokens;
      if (typeof usage.cache_read_input_tokens === "number") tokenUsage.cacheReadInputTokens = usage.cache_read_input_tokens;
    }

    return {
      kind: "relay_event",
      relayEvent: {
        type: "turn_end",
        subtype: msg.subtype,
        numTurns: msg.num_turns,
        costUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
        isError: msg.is_error,
        usage: msg.usage,
      },
      ...(tokenUsage ? { tokenUsage } : {}),
    };
  }

  // ── Partial streaming events ──────────────────────────────────────────
  // Translate stream_event into message_update with assistantMessageEvent
  // so the UI can handle partial streaming content
  if (type === "stream_event") {
    // Extract the event subtype — Claude Code uses "event" for the delta type name
    // (e.g. "text_delta", "thinking_delta", "thinking_start", "thinking_end", "toolcall_delta").
    const eventType = typeof msg.event === "string" ? msg.event : undefined;
    // Delta may be a string directly, or an object with a .text field.
    const rawDelta = msg.delta;
    const delta = typeof rawDelta === "string"
      ? rawDelta
      : (rawDelta && typeof rawDelta === "object" && typeof (rawDelta as Record<string, unknown>).text === "string")
        ? (rawDelta as Record<string, unknown>).text as string
        : undefined;
    const contentIndex = typeof msg.index === "number" ? msg.index : undefined;

    return {
      kind: "relay_event",
      relayEvent: {
        type: "message_update",
        assistantMessageEvent: {
          type: eventType,
          delta,
          contentIndex,
          partial: msg,
        },
      },
      parentToolUseId,
    };
  }

  // ── Tool progress heartbeats ──────────────────────────────────────────
  // Claude Code emits these periodically for long-running tool executions.
  if (type === "tool_progress") {
    return {
      kind: "relay_event",
      relayEvent: {
        type: "tool_progress",
        toolCallId: typeof msg.tool_use_id === "string" ? msg.tool_use_id : undefined,
        toolName: typeof msg.tool_name === "string" ? msg.tool_name : undefined,
        elapsedSeconds: typeof msg.elapsed_time_seconds === "number" ? msg.elapsed_time_seconds : undefined,
      },
      parentToolUseId,
    };
  }

  // ── System status changes (compaction, etc.) ──────────────────────────
  if (type === "system" && msg.subtype === "status") {
    return {
      kind: "relay_event",
      relayEvent: {
        type: "system_status",
        status: typeof msg.status === "string" ? msg.status : null,
        permissionMode: typeof msg.permissionMode === "string" ? msg.permissionMode : undefined,
      },
    };
  }

  // ── Compact boundary ──────────────────────────────────────────────────
  if (type === "system" && msg.subtype === "compact_boundary") {
    const meta = msg.compact_metadata as Record<string, unknown> | undefined;
    return {
      kind: "relay_event",
      relayEvent: {
        type: "compact_boundary",
        trigger: typeof meta?.trigger === "string" ? meta.trigger : "auto",
        preTokens: typeof meta?.pre_tokens === "number" ? meta.pre_tokens : undefined,
      },
    };
  }

  return { kind: "unknown" };
}

// ── Subagent tool call XML parser ──────────────────────────────────────

const STUB_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeAssistantMessage(
  content: Record<string, unknown>[],
  stopReason = "stop",
): Record<string, unknown> {
  return { role: "assistant", content, usage: { ...STUB_USAGE }, stopReason, timestamp: 0 };
}

function makeToolResultMessage(
  toolCallId: string,
  toolName: string,
  rawContent: string,
): Record<string, unknown> {
  const isError = rawContent.includes("<is_error>true</is_error>");
  const text = rawContent.replace(/<is_error>.*?<\/is_error>/gs, "").trim();
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: 0,
  };
}

/**
 * Parse Claude Code's XML-serialized subagent tool calls into structured
 * Message-compatible objects. Uses a state machine to avoid misinterpreting
 * <tool_call> text that appears inside <tool_result> blocks.
 *
 * Returns an array of synthetic messages matching pi-ai's Message shape:
 * - AssistantMessage with ToolCall content parts (role: "assistant")
 * - ToolResultMessage (role: "toolResult")
 *
 * If no <tool_call> tags are found, returns a single assistant text message
 * (backward-compatible fallback).
 */
export function parseSubagentToolCalls(text: string): Record<string, unknown>[] {
  // Quick check: if no tool_call tags, return plain text fallback
  if (!text.includes("<tool_call>")) {
    return [makeAssistantMessage([{ type: "text", text }])];
  }

  const messages: Record<string, unknown>[] = [];
  let assistantContent: Record<string, unknown>[] = [];
  let toolCallCounter = 0;
  let lastToolName = "";
  let lastToolCallId = "";

  type State = "outside" | "in_call" | "in_result";
  let state: State = "outside";
  let pos = 0;

  while (pos < text.length) {
    if (state === "outside") {
      const nextCall = text.indexOf("<tool_call>", pos);
      if (nextCall === -1) {
        // Rest is plain text
        const remaining = text.slice(pos).trim();
        if (remaining) assistantContent.push({ type: "text", text: remaining });
        break;
      }
      // Text before the tool call
      const before = text.slice(pos, nextCall).trim();
      if (before) assistantContent.push({ type: "text", text: before });
      pos = nextCall + "<tool_call>".length;
      state = "in_call";
      continue;
    }

    if (state === "in_call") {
      const endCall = text.indexOf("</tool_call>", pos);
      if (endCall === -1) break; // malformed — bail

      const callBody = text.slice(pos, endCall);

      // Extract tool_name
      const nameMatch = callBody.match(/<tool_name>(.*?)<\/tool_name>/s);
      const toolName = nameMatch ? nameMatch[1].trim() : "unknown";

      // Extract tool_input
      const inputMatch = callBody.match(/<tool_input>(.*?)<\/tool_input>/s);
      const rawInput = inputMatch ? inputMatch[1].trim() : "";
      let toolInput: Record<string, unknown>;
      try {
        toolInput = JSON.parse(rawInput) as Record<string, unknown>;
      } catch {
        toolInput = { raw: rawInput };
      }

      const toolCallId = `cc-tc-${toolCallCounter++}`;
      lastToolName = toolName;
      lastToolCallId = toolCallId;

      assistantContent.push({ type: "toolCall", id: toolCallId, name: toolName, arguments: toolInput });

      pos = endCall + "</tool_call>".length;

      // Look ahead: another <tool_call> immediately (parallel), or <tool_result>, or return outside
      const afterClose = text.slice(pos);
      const resultStart = afterClose.match(/^\s*<tool_result>/);
      if (resultStart) {
        // Flush assistant message before entering result
        if (assistantContent.length > 0) {
          messages.push(makeAssistantMessage(assistantContent, "toolUse"));
          assistantContent = [];
        }
        pos += resultStart[0].length;
        state = "in_result";
      } else {
        const nextCallAhead = afterClose.match(/^\s*<tool_call>/);
        if (nextCallAhead) {
          // Another tool call — stay in in_call, accumulate in same assistant message
          pos += nextCallAhead[0].length;
          state = "in_call";
        } else {
          // Back to outside
          if (assistantContent.length > 0) {
            messages.push(makeAssistantMessage(assistantContent, "toolUse"));
            assistantContent = [];
          }
          state = "outside";
        }
      }
      continue;
    }

    if (state === "in_result") {
      // Only scan for </tool_result> — NOT <tool_call> (state machine safety)
      const endResult = text.indexOf("</tool_result>", pos);
      let resultText: string;
      if (endResult === -1) {
        // No closing tag — rest of text is the result
        resultText = text.slice(pos).trim();
        messages.push(makeToolResultMessage(lastToolCallId, lastToolName, resultText));
        break;
      }
      resultText = text.slice(pos, endResult).trim();
      messages.push(makeToolResultMessage(lastToolCallId, lastToolName, resultText));
      pos = endResult + "</tool_result>".length;
      state = "outside";
      continue;
    }
  }

  // Flush any remaining assistant content
  if (assistantContent.length > 0) {
    messages.push(makeAssistantMessage(assistantContent));
  }

  return messages.length > 0 ? messages : [makeAssistantMessage([{ type: "text", text }])];
}
