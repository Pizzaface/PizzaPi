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

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use") continue;

      // AskUserQuestion — needs special handling
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
      if (b.name === "TodoWrite") {
        const input = b.input as Record<string, unknown> | undefined;
        const todos = Array.isArray(input?.todos)
          ? (input!.todos as unknown[]).filter((t): t is Record<string, unknown> => !!t && typeof t === "object").map((t) => ({
              id: String(t.id ?? ""),
              content: String(t.content ?? ""),
              status: String(t.status ?? "pending"),
              priority: String(t.priority ?? "medium"),
            }))
          : [];
        return {
          kind: "relay_event",
          relayEvent: { type: "message_update", role: "assistant", message },
          todoList: todos,
        };
      }
    }

    return {
      kind: "relay_event",
      relayEvent: { type: "message_update", role: "assistant", message },
    };
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
    return {
      kind: "relay_event",
      relayEvent: {
        type: "agent_end",
        subtype: msg.subtype,
        numTurns: msg.num_turns,
        costUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
        isError: msg.is_error,
        usage: msg.usage,
      },
    };
  }

  // ── Partial streaming events ──────────────────────────────────────────
  if (type === "stream_event") {
    return {
      kind: "relay_event",
      relayEvent: { type: "message_update_partial", event: msg },
    };
  }

  return { kind: "unknown" };
}
