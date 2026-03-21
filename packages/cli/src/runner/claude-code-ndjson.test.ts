import { test, expect, describe } from "bun:test";
import { translateNdjsonLine } from "./claude-code-ndjson.js";

describe("translateNdjsonLine", () => {
  test("ignores control_request frames (not relay events)", () => {
    const line = JSON.stringify({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("control_request");
    expect(result.relayEvent).toBeUndefined();
  });

  test("ignores control_response frames", () => {
    const line = JSON.stringify({ type: "control_response", response: { request_id: "r1", subtype: "success" } });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("control_response");
  });

  test("translates system/init to session_active metadata", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", session_id: "sess1", model: "claude-sonnet-4-6", cwd: "/tmp", tools: ["Bash", "Read"], slash_commands: [] });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("session_init");
    expect(result.sessionId).toBe("sess1");
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  test("translates assistant message to message_update", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    expect(result.relayEvent?.type).toBe("message_update");
  });

  test("detects TodoWrite tool_use in assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "TodoWrite", input: { todos: [{ id: "1", content: "Do thing", status: "pending", priority: "high" }] } }],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    expect(result.todoList).toBeDefined();
    expect(result.todoList).toHaveLength(1);
  });

  test("detects AskUserQuestion tool_use — emits tool_execution_start", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu2", name: "AskUserQuestion", input: { questions: [{ question: "Pick one", options: ["A", "B"] }] } }],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("ask_user_question");
    expect(result.toolCallId).toBe("tu2");
    expect(result.questions).toHaveLength(1);
  });

  test("translates result to agent_end", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      num_turns: 2,
      total_cost_usd: 0.01,
      duration_ms: 1234,
      duration_api_ms: 1000,
      is_error: false,
      session_id: "sess1",
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    expect(result.relayEvent?.type).toBe("turn_end");
  });

  test("extracts tokenUsage from result event", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      num_turns: 1,
      usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 100, cache_read_input_tokens: 50 },
    });
    const result = translateNdjsonLine(line);
    expect(result.tokenUsage).toEqual({
      inputTokens: 500,
      outputTokens: 200,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 50,
    });
  });

  test("detects set_session_name in assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "set_session_name", id: "call_1", input: { name: "My Session" } },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.sessionName).toBe("My Session");
  });

  test("translates stream_event to message_update with assistantMessageEvent", () => {
    const line = JSON.stringify({
      type: "stream_event",
      delta: { text: "Hello" },
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    expect(result.relayEvent?.type).toBe("message_update");
    expect((result.relayEvent as any)?.assistantMessageEvent?.partial).toBeDefined();
  });

  test("returns unknown for unrecognised line", () => {
    const result = translateNdjsonLine("not-json!!!");
    expect(result.kind).toBe("unknown");
  });
});
