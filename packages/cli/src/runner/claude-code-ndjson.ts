/**
 * Translates Claude Code CLI NDJSON output lines into PizzaPi relay events.
 */

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
}

export function translateNdjsonLine(line: string): TranslationResult {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    return { kind: "unknown" };
  }

  const type = msg.type;

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
    const normalizedContent = content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use") return block;
      return {
        type: "toolCall",
        toolCallId: typeof b.id === "string" ? b.id : undefined,
        name: typeof b.name === "string" ? b.name : undefined,
        arguments: b.input != null ? JSON.stringify(b.input) : undefined,
      };
    });
    const normalizedMessage = { ...message, content: normalizedContent };

    const result: TranslationResult = {
      kind: "relay_event",
      relayEvent: { type: "message_update", role: "assistant", message: normalizedMessage },
    };
    if (todoList) result.todoList = todoList;
    if (sessionName) result.sessionName = sessionName;
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
      };
    }

    // Build one relay event per tool_result block, plus one user event for any
    // remaining non-tool_result blocks.
    const events: Array<Record<string, unknown>> = [];

    for (const block of toolResultBlocks) {
      const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
      // content can be a string, an array of content blocks, or absent
      const blockContent = block.content ?? "";
      const isError = block.is_error === true;

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

    if (events.length === 1) {
      return { kind: "relay_event", relayEvent: events[0] };
    }

    return { kind: "relay_event", relayEvents: events };
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
    };
  }

  return { kind: "unknown" };
}
