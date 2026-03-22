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

  test("normalizes tool_use blocks to toolCall format", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that." },
          { type: "tool_use", id: "tu_123", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    const msg = (result.relayEvent as any)?.message;
    expect(msg.content[0]).toMatchObject({ type: "text", text: "Let me run that." });
    expect(msg.content[1]).toMatchObject({
      type: "toolCall",
      toolCallId: "tu_123",
      name: "Bash",
      arguments: JSON.stringify({ command: "ls" }),
    });
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
    expect(result.todoList?.[0]).toMatchObject({
      text: "Do thing",
      content: "Do thing",
      status: "pending",
      priority: "high",
    });
  });

  test("normalizes TodoWrite statuses to the UI enum", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "TodoWrite", input: { todos: [{ id: "1", text: "Ship it", status: "completed" }] } }],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.todoList?.[0]).toMatchObject({
      text: "Ship it",
      status: "pending",
    });
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
    // relayEvent must be present so the bridge can save the assistant message to history
    expect(result.relayEvent).toBeDefined();
    expect(result.relayEvent?.type).toBe("message_update");
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
      event: "text_delta",
      delta: { text: "Hello" },
      index: 0,
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    expect(result.relayEvent?.type).toBe("message_update");
    const ae = (result.relayEvent as any)?.assistantMessageEvent;
    expect(ae?.partial).toBeDefined();
    expect(ae?.type).toBe("text_delta");
    expect(ae?.delta).toBe("Hello");
    expect(ae?.contentIndex).toBe(0);
  });

  test("stream_event with string delta", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: "thinking_delta",
      delta: "some thought",
      index: 1,
    });
    const result = translateNdjsonLine(line);
    const ae = (result.relayEvent as any)?.assistantMessageEvent;
    expect(ae?.type).toBe("thinking_delta");
    expect(ae?.delta).toBe("some thought");
    expect(ae?.contentIndex).toBe(1);
  });

  test("returns unknown for unrecognised line", () => {
    const result = translateNdjsonLine("not-json!!!");
    expect(result.kind).toBe("unknown");
  });

  // ── tool_result extraction from user messages ─────────────────────────

  test("user message with string tool_result content → toolResult relay event", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_abc123", content: "file1\nfile2" },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    // Single event → uses relayEvent (not relayEvents)
    expect(result.relayEvent).toBeDefined();
    const msg = (result.relayEvent as any).message;
    expect(msg.role).toBe("toolResult");
    expect(msg.toolCallId).toBe("toolu_abc123");
    expect(msg.content).toBe("file1\nfile2");
    expect(msg.isError).toBe(false);
  });

  test("user message with array tool_result content → toolResult relay event", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_xyz",
            content: [{ type: "text", text: "some output" }],
          },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    const msg = (result.relayEvent as any).message;
    expect(msg.role).toBe("toolResult");
    expect(msg.toolCallId).toBe("toolu_xyz");
    expect(Array.isArray(msg.content)).toBe(true);
    expect((msg.content as any[])[0]).toMatchObject({ type: "text", text: "some output" });
    expect(msg.isError).toBe(false);
  });

  test("tool_result with is_error: true → isError: true on relay event", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_err",
            content: "Command failed",
            is_error: true,
          },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    const msg = (result.relayEvent as any).message;
    expect(msg.role).toBe("toolResult");
    expect(msg.isError).toBe(true);
    expect(msg.content).toBe("Command failed");
  });

  test("multiple tool_result blocks in one user message → relayEvents array", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "result1" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "result2" },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    // Multiple events → uses relayEvents
    expect(result.relayEvents).toBeDefined();
    expect(result.relayEvent).toBeUndefined();
    expect(result.relayEvents).toHaveLength(2);
    const [ev1, ev2] = result.relayEvents!;
    expect((ev1.message as any).role).toBe("toolResult");
    expect((ev1.message as any).toolCallId).toBe("toolu_1");
    expect((ev1.message as any).content).toBe("result1");
    expect((ev2.message as any).role).toBe("toolResult");
    expect((ev2.message as any).toolCallId).toBe("toolu_2");
    expect((ev2.message as any).content).toBe("result2");
  });

  test("user message with tool_result AND text blocks → toolResult + user events", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_3", content: "tool output" },
          { type: "text", text: "follow-up user text" },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    // Two events: toolResult first, then user
    expect(result.relayEvents).toBeDefined();
    expect(result.relayEvent).toBeUndefined();
    expect(result.relayEvents).toHaveLength(2);
    const [toolEv, userEv] = result.relayEvents!;
    expect((toolEv.message as any).role).toBe("toolResult");
    expect((toolEv.message as any).toolCallId).toBe("toolu_3");
    expect((toolEv.message as any).content).toBe("tool output");
    expect((userEv.message as any).role).toBe("user");
    expect((userEv.message as any).content).toEqual([{ type: "text", text: "follow-up user text" }]);
  });

  test("user message with no tool_results passes through as-is", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Hello!" }] },
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    expect(result.relayEvents).toBeUndefined();
    const msg = (result.relayEvent as any).message;
    expect(msg.role).toBe("user");
  });

  test("user message with no content array passes through as-is", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: "plain string content" },
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    expect(result.relayEvents).toBeUndefined();
    const msg = (result.relayEvent as any).message;
    expect(msg.role).toBe("user");
  });

  test("tool_result with empty/absent content → content defaults to empty string", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_empty" },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    const msg = (result.relayEvent as any).message;
    expect(msg.role).toBe("toolResult");
    expect(msg.toolCallId).toBe("toolu_empty");
    // Absent content defaults to empty string
    expect(msg.content).toBe("");
    expect(msg.isError).toBe(false);
  });
});
