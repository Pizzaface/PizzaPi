import { test, expect, describe } from "bun:test";
import { translateNdjsonLine, SUBAGENT_TOOL_NAMES, parseSubagentToolCalls } from "./claude-code-ndjson.js";

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

  // ── toolCalls extraction from assistant messages ──────────────────────

  test("extracts toolCalls from assistant message with tool_use blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Running commands." },
          { type: "tool_use", id: "tc_1", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "tc_2", name: "Read", input: { path: "file.txt" } },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0]).toMatchObject({
      toolCallId: "tc_1",
      toolName: "Bash",
      toolInput: { command: "ls" },
    });
    expect(result.toolCalls![1]).toMatchObject({
      toolCallId: "tc_2",
      toolName: "Read",
      toolInput: { path: "file.txt" },
    });
  });

  test("extracts toolCalls for subagent tool_use", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tc_sub", name: "subagent", input: { agent: "task", task: "Do something" } },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toMatchObject({
      toolCallId: "tc_sub",
      toolName: "subagent",
      toolInput: { agent: "task", task: "Do something" },
    });
  });

  test("excludes side-effect-only tools from toolCalls", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tc_todo", name: "TodoWrite", input: { todos: [] } },
          { type: "tool_use", id: "tc_name", name: "set_session_name", input: { name: "Test" } },
          { type: "tool_use", id: "tc_utodo", name: "update_todo", input: { todos: [] } },
          { type: "tool_use", id: "tc_bash", name: "Bash", input: { command: "echo hi" } },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    // Only Bash should be in toolCalls — side-effect tools are excluded
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].toolName).toBe("Bash");
  });

  test("excludes AskUserQuestion from toolCalls (has its own path)", () => {
    // AskUserQuestion returns ask_user_question kind, not relay_event, so
    // toolCalls should not be populated. Verify by using a message with both
    // AskUserQuestion and another tool — AskUserQuestion takes over the result.
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tc_ask", name: "AskUserQuestion", input: { questions: [] } },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("ask_user_question");
    // AskUserQuestion returns early — no toolCalls extracted
    expect(result.toolCalls).toBeUndefined();
  });

  test("no toolCalls for assistant messages without tool_use blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Just text, no tools." }],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.toolCalls).toBeUndefined();
  });

  // ── toolResultIds extraction from user messages ───────────────────────

  test("extracts toolResultIds from tool_result blocks", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tc_1", content: "result 1" },
          { type: "tool_result", tool_use_id: "tc_2", content: "result 2" },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.toolResultIds).toEqual(["tc_1", "tc_2"]);
  });

  test("single tool_result extracts toolResultIds", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tc_single", content: "done" },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.toolResultIds).toEqual(["tc_single"]);
  });

  test("no toolResultIds for user messages without tool_results", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Hello" }] },
    });
    const result = translateNdjsonLine(line);
    expect(result.toolResultIds).toBeUndefined();
  });

  // ── Claude Code subagent tool recognition ─────────────────────────────

  test("SUBAGENT_TOOL_NAMES includes Task, Agent, and subagent", () => {
    expect(SUBAGENT_TOOL_NAMES.has("Task")).toBe(true);
    expect(SUBAGENT_TOOL_NAMES.has("Agent")).toBe(true);
    expect(SUBAGENT_TOOL_NAMES.has("subagent")).toBe(true);
    // Common non-subagent tools should NOT be in the set
    expect(SUBAGENT_TOOL_NAMES.has("Bash")).toBe(false);
    expect(SUBAGENT_TOOL_NAMES.has("Read")).toBe(false);
  });

  test("extracts toolCalls for Claude Code Task tool", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tc_task", name: "Task", input: {
            subagent_type: "Explore",
            description: "Find auth code",
            prompt: "Search for authentication patterns",
          } },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toMatchObject({
      toolCallId: "tc_task",
      toolName: "Task",
      toolInput: {
        subagent_type: "Explore",
        description: "Find auth code",
        prompt: "Search for authentication patterns",
      },
    });
  });

  test("extracts toolCalls for Claude Code Agent tool (newer SDK)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tc_agent", name: "Agent", input: {
            subagent_type: "general-purpose",
            prompt: "Implement the feature",
          } },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].toolName).toBe("Agent");
  });

  test("normalizes Task tool_use to toolCall format like any other tool", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tc_task", name: "Task", input: {
            subagent_type: "Explore",
            prompt: "Find files",
          } },
        ],
      },
    });
    const result = translateNdjsonLine(line);
    const msg = (result.relayEvent as any)?.message;
    expect(msg.content[0]).toMatchObject({
      type: "toolCall",
      toolCallId: "tc_task",
      name: "Task",
      arguments: JSON.stringify({ subagent_type: "Explore", prompt: "Find files" }),
    });
  });

  // ── parentToolUseId extraction ──────────────────────────────────────

  test("extracts parentToolUseId from assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      parent_tool_use_id: "toolu_abc123",
      message: { role: "assistant", content: [{ type: "text", text: "subagent response" }] },
    });
    const result = translateNdjsonLine(line);
    expect(result.parentToolUseId).toBe("toolu_abc123");
  });

  test("parentToolUseId is undefined when parent_tool_use_id is null", () => {
    const line = JSON.stringify({
      type: "assistant",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "top-level response" }] },
    });
    const result = translateNdjsonLine(line);
    expect(result.parentToolUseId).toBeUndefined();
  });

  test("parentToolUseId is undefined when field is absent", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "no parent" }] },
    });
    const result = translateNdjsonLine(line);
    expect(result.parentToolUseId).toBeUndefined();
  });

  test("extracts parentToolUseId from user message", () => {
    const line = JSON.stringify({
      type: "user",
      parent_tool_use_id: "toolu_xyz789",
      message: { role: "user", content: "subagent prompt" },
    });
    const result = translateNdjsonLine(line);
    expect(result.parentToolUseId).toBe("toolu_xyz789");
  });

  test("extracts parentToolUseId from stream_event", () => {
    const line = JSON.stringify({
      type: "stream_event",
      parent_tool_use_id: "toolu_stream1",
      event: "text_delta",
      delta: "partial text",
    });
    const result = translateNdjsonLine(line);
    expect(result.parentToolUseId).toBe("toolu_stream1");
  });

  // ── tool_progress events ────────────────────────────────────────────

  test("translates tool_progress to relay event", () => {
    const line = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tc_bash1",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 12.5,
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    expect(result.relayEvent).toMatchObject({
      type: "tool_progress",
      toolCallId: "tc_bash1",
      toolName: "Bash",
      elapsedSeconds: 12.5,
    });
    expect(result.parentToolUseId).toBeUndefined();
  });

  test("tool_progress from subagent has parentToolUseId", () => {
    const line = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tc_read1",
      tool_name: "Read",
      parent_tool_use_id: "toolu_agent1",
      elapsed_time_seconds: 3,
    });
    const result = translateNdjsonLine(line);
    expect(result.parentToolUseId).toBe("toolu_agent1");
  });

  // ── system/status events ────────────────────────────────────────────

  test("translates system/status compacting to relay event", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "status",
      status: "compacting",
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    expect(result.relayEvent).toMatchObject({
      type: "system_status",
      status: "compacting",
    });
  });

  test("translates system/status null (compaction ended) to relay event", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "status",
      status: null,
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    expect((result.relayEvent as any).status).toBeNull();
  });

  // ── compact_boundary events ─────────────────────────────────────────

  test("translates system/compact_boundary to relay event", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 180000 },
    });
    const result = translateNdjsonLine(line);
    expect(result.kind).toBe("relay_event");
    expect(result.relayEvent).toMatchObject({
      type: "compact_boundary",
      trigger: "auto",
      preTokens: 180000,
    });
  });
});

describe("parseSubagentToolCalls", () => {
  test("returns single text message when no <tool_call> tags found", () => {
    const result = parseSubagentToolCalls("Just a plain text response.");
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toEqual([{ type: "text", text: "Just a plain text response." }]);
  });

  test("returns single text message for empty input", () => {
    const result = parseSubagentToolCalls("");
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toEqual([{ type: "text", text: "" }]);
  });

  test("parses single tool call with result", () => {
    const input = `<tool_call> <tool_name>bash</tool_name> <tool_input>{"command": "ls"}</tool_input> </tool_call> <tool_result>
file1.ts
file2.ts
</tool_result>`;

    const result = parseSubagentToolCalls(input);

    expect(result.length).toBeGreaterThanOrEqual(2);

    const assistant = result.find(m => m.role === "assistant" && Array.isArray(m.content) && (m.content as any[]).some((c: any) => c.type === "toolCall"));
    expect(assistant).toBeDefined();

    const toolCall = (assistant!.content as any[]).find((c: any) => c.type === "toolCall");
    expect(toolCall.name).toBe("bash");
    expect(toolCall.arguments).toEqual({ command: "ls" });
    expect(toolCall.id).toMatch(/^cc-tc-/);

    const toolResult = result.find(m => m.role === "toolResult") as any;
    expect(toolResult).toBeDefined();
    expect(toolResult.toolCallId).toBe(toolCall.id);
    expect(toolResult.toolName).toBe("bash");
    expect(toolResult.isError).toBe(false);
  });

  test("parses multiple sequential tool calls", () => {
    const input = `<tool_call> <tool_name>bash</tool_name> <tool_input>{"command": "pwd"}</tool_input> </tool_call> <tool_result>/home/user</tool_result>

<tool_call> <tool_name>read</tool_name> <tool_input>{"path": "README.md"}</tool_input> </tool_call> <tool_result>
# Hello
</tool_result>`;

    const result = parseSubagentToolCalls(input);
    const toolResults = result.filter(m => m.role === "toolResult");
    expect(toolResults).toHaveLength(2);
    expect((toolResults[0] as any).toolName).toBe("bash");
    expect((toolResults[1] as any).toolName).toBe("read");
  });

  test("captures interleaved text between tool calls", () => {
    const input = `Let me check the files.

<tool_call> <tool_name>bash</tool_name> <tool_input>{"command": "ls"}</tool_input> </tool_call> <tool_result>file1.ts</tool_result>

Found the file. Now reading it.

<tool_call> <tool_name>read</tool_name> <tool_input>{"path": "file1.ts"}</tool_input> </tool_call> <tool_result>content</tool_result>

Done reviewing.`;

    const result = parseSubagentToolCalls(input);

    const textMessages = result.filter(m =>
      m.role === "assistant" && Array.isArray(m.content) &&
      (m.content as any[]).some((c: any) => c.type === "text")
    );
    expect(textMessages.length).toBeGreaterThanOrEqual(1);

    const lastAssistant = [...result].reverse().find(m => m.role === "assistant");
    const lastText = (lastAssistant!.content as any[]).find((c: any) => c.type === "text");
    expect(lastText?.text).toContain("Done reviewing");
  });

  test("does not parse <tool_call> inside <tool_result>", () => {
    const input = `<tool_call> <tool_name>bash</tool_name> <tool_input>{"command": "cat example.xml"}</tool_input> </tool_call> <tool_result>
Here is the file:
<tool_call> <tool_name>fake</tool_name> <tool_input>{"not": "real"}</tool_input> </tool_call>
</tool_result>`;

    const result = parseSubagentToolCalls(input);
    const toolResults = result.filter(m => m.role === "toolResult");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).toolName).toBe("bash");

    const resultText = (toolResults[0] as any).content[0].text;
    expect(resultText).toContain("<tool_call>");
  });

  test("handles malformed JSON in tool_input", () => {
    const input = `<tool_call> <tool_name>bash</tool_name> <tool_input>not valid json</tool_input> </tool_call> <tool_result>output</tool_result>`;

    const result = parseSubagentToolCalls(input);
    const assistant = result.find(m => m.role === "assistant" && Array.isArray(m.content) && (m.content as any[]).some((c: any) => c.type === "toolCall"));
    const toolCall = (assistant!.content as any[]).find((c: any) => c.type === "toolCall");
    expect(toolCall.arguments).toEqual({ raw: "not valid json" });
  });

  test("handles missing </tool_result> tag", () => {
    const input = `<tool_call> <tool_name>bash</tool_name> <tool_input>{"command": "ls"}</tool_input> </tool_call> <tool_result>
output without closing tag`;

    const result = parseSubagentToolCalls(input);
    const toolResult = result.find(m => m.role === "toolResult") as any;
    expect(toolResult).toBeDefined();
    expect(toolResult.content[0].text).toContain("output without closing tag");
  });

  test("preserves JSON text in tool result (read tool output)", () => {
    const input = `<tool_call> <tool_name>read</tool_name> <tool_input>{"path": "data.json"}</tool_input> </tool_call> <tool_result>{"key": "value", "nested": {"a": 1}}</tool_result>`;

    const result = parseSubagentToolCalls(input);
    const toolResult = result.find(m => m.role === "toolResult") as any;
    expect(toolResult.content[0].text).toBe('{"key": "value", "nested": {"a": 1}}');
  });

  test("groups consecutive tool calls into a single assistant message", () => {
    const input = `<tool_call> <tool_name>bash</tool_name> <tool_input>{"command": "pwd"}</tool_input> </tool_call> <tool_call> <tool_name>bash</tool_name> <tool_input>{"command": "whoami"}</tool_input> </tool_call> <tool_result>/home/user</tool_result> <tool_result>jordan</tool_result>`;

    const result = parseSubagentToolCalls(input);
    const firstAssistant = result[0] as any;
    expect(firstAssistant.role).toBe("assistant");
    const toolCalls = firstAssistant.content.filter((c: any) => c.type === "toolCall");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].name).toBe("bash");
    expect(toolCalls[1].name).toBe("bash");
    expect(toolCalls[0].id).not.toBe(toolCalls[1].id);

    // Both tool results must be present and correctly attributed (parallel result matching)
    const toolResults = result.filter(m => m.role === "toolResult") as any[];
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0].toolCallId).toBe(toolCalls[0].id);
    expect(toolResults[1].toolCallId).toBe(toolCalls[1].id);

    // No stray assistant text message should contain raw <tool_result> markup
    const leakedMarkup = result.filter(m =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      (m.content as any[]).some(
        (c: any) => c.type === "text" && typeof c.text === "string" && c.text.includes("<tool_result>"),
      ),
    );
    expect(leakedMarkup).toHaveLength(0);
  });
});
