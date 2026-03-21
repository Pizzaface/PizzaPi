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
  todoList?: Array<{ id: string; content: string; status: string; priority: string }>;
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
        return {
          kind: "ask_user_question",
          toolCallId: typeof b.id === "string" ? b.id : undefined,
          questions,
        };
      }

      // TodoWrite — extract todo list as a side-effect
      if (b.name === "TodoWrite" || b.name === "update_todo") {
        const input = b.input as Record<string, unknown> | undefined;
        const rawTodos = Array.isArray(input?.todos) ? input!.todos as unknown[] : [];
        todoList = rawTodos
          .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
          .map((t) => ({
            id: String(t.id ?? ""),
            content: String(t.content ?? t.text ?? ""),
            status: String(t.status ?? "pending"),
            priority: String(t.priority ?? "medium"),
          }));
      }

      // set_session_name — extract session name as a side-effect
      if (b.name === "set_session_name") {
        const input = b.input as Record<string, unknown> | undefined;
        const name = typeof input?.name === "string" ? input.name.trim() : "";
        if (name) sessionName = name;
      }
    }

    const result: TranslationResult = {
      kind: "relay_event",
      relayEvent: { type: "message_update", role: "assistant", message },
    };
    if (todoList) result.todoList = todoList;
    if (sessionName) result.sessionName = sessionName;
    return result;
  }

  // ── User messages (replayed with --replay-user-messages) ──────────────
  if (type === "user") {
    return {
      kind: "relay_event",
      relayEvent: { type: "message_update", role: "user", message: msg.message },
    };
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
    return {
      kind: "relay_event",
      relayEvent: {
        type: "message_update",
        assistantMessageEvent: {
          partial: msg,
        },
      },
    };
  }

  return { kind: "unknown" };
}
