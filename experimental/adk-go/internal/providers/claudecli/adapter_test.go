package claudecli

import (
	"encoding/json"
	"testing"
)

func TestAdapterSystemEventHeartbeat(t *testing.T) {
	a := NewAdapter()
	events := a.HandleEvent(&SystemEvent{Cwd: "/tmp", Model: "claude-sonnet-4-20250514"})
	if len(events) != 2 {
		t.Fatalf("expected 2 events (heartbeat + session_active), got %d", len(events))
	}
	assertEventType(t, events[0], "heartbeat")
	assertEventType(t, events[1], "session_active")
	if events[0]["active"] != true {
		t.Fatalf("expected active=true: %+v", events[0])
	}
	model, ok := events[0]["model"].(map[string]any)
	if !ok {
		t.Fatalf("model missing: %+v", events[0])
	}
	if model["provider"] != "anthropic" || model["id"] != "claude-sonnet-4-20250514" {
		t.Fatalf("unexpected model: %+v", model)
	}
}

func TestAdapterMessageStartEmitsEvent(t *testing.T) {
	a := NewAdapter()
	events := a.HandleEvent(&MessageStart{MessageID: "msg_01", Role: "assistant"})
	if len(events) != 1 {
		t.Fatalf("expected 1 event (message_start), got %d", len(events))
	}
	assertEventType(t, events[0], "message_start")
	msg := events[0]["message"].(map[string]any)
	if msg["role"] != "assistant" {
		t.Fatalf("unexpected role: %+v", msg)
	}
}

func TestAdapterStreamingTextMessageUpdate(t *testing.T) {
	a := NewAdapter()
	a.HandleEvent(&MessageStart{MessageID: "msg_01", Role: "assistant"})
	a.HandleEvent(&ContentBlockStart{Index: 0, BlockType: "text"})

	events := a.HandleEvent(&ContentBlockDelta{Index: 0, DeltaType: "text_delta", Text: "Hello"})
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	assertEventType(t, events[0], "message_update")

	// Streaming events use assistantMessageEvent wrapper
	ame := events[0]["assistantMessageEvent"].(map[string]any)
	partial := ame["partial"].(map[string]any)
	content := getContent(t, partial)
	if len(content) != 1 || content[0]["text"] != "Hello" {
		t.Fatalf("unexpected content in partial: %+v", content)
	}

	events = a.HandleEvent(&ContentBlockDelta{Index: 0, DeltaType: "text_delta", Text: " world"})
	ame = events[0]["assistantMessageEvent"].(map[string]any)
	partial = ame["partial"].(map[string]any)
	content = getContent(t, partial)
	if len(content) != 1 || content[0]["text"] != "Hello world" {
		t.Fatalf("unexpected accumulated content: %+v", content)
	}
}

func TestAdapterToolCallAssembly(t *testing.T) {
	a := NewAdapter()
	a.HandleEvent(&MessageStart{MessageID: "msg_01"})

	// ContentBlockStart for tool_use now emits tool_execution_start
	toolStartEvents := a.HandleEvent(&ContentBlockStart{Index: 1, BlockType: "tool_use", ToolID: "tool_abc", ToolName: "bash"})
	if len(toolStartEvents) != 1 {
		t.Fatalf("expected 1 event (tool_execution_start), got %d", len(toolStartEvents))
	}
	assertEventType(t, toolStartEvents[0], "tool_execution_start")

	// Input delta now emits streaming assistantMessageEvent
	deltaEvents := a.HandleEvent(&ContentBlockDelta{Index: 1, DeltaType: "input_json_delta", PartialJSON: `{"command":"ls"}`})
	if len(deltaEvents) != 1 {
		t.Fatalf("expected 1 event (streaming delta), got %d", len(deltaEvents))
	}
	assertEventType(t, deltaEvents[0], "message_update")

	if got := a.HandleEvent(&ContentBlockStop{Index: 1}); len(got) != 0 {
		t.Fatalf("expected no events from ContentBlockStop, got %+v", got)
	}

	// AssistantMessage now emits message_update + message_end
	events := a.HandleEvent(&AssistantMessage{Message: mustJSON(t, map[string]any{
		"id":   "msg_01",
		"role": "assistant",
		"content": []map[string]any{
			{"type": "tool_use", "id": "tool_abc", "name": "bash", "input": map[string]any{"command": "ls"}},
		},
	})})
	if len(events) != 2 {
		t.Fatalf("expected 2 events (message_update + message_end), got %d", len(events))
	}
	assertEventType(t, events[0], "message_update")

	// Content is now nested under events[0]["message"]
	msg := events[0]["message"].(map[string]any)
	content := getContent(t, msg)
	if len(content) != 1 {
		t.Fatalf("expected 1 content block, got %+v", content)
	}
	if content[0]["type"] != "tool_use" || content[0]["id"] != "tool_abc" || content[0]["name"] != "bash" {
		t.Fatalf("unexpected tool block: %+v", content[0])
	}
	input, ok := content[0]["input"].(map[string]any)
	if !ok || input["command"] != "ls" {
		t.Fatalf("unexpected tool input: %+v", content[0]["input"])
	}
}

func TestAdapterToolResultEvent(t *testing.T) {
	a := NewAdapter()
	a.HandleEvent(&ToolUseEvent{ToolID: "tool_abc", Name: "bash", Input: mustJSON(t, map[string]any{"command": "ls"})})

	// Now emits tool_result_message + tool_execution_end
	events := a.HandleEvent(&ToolResultEvent{ToolID: "tool_abc", Content: "file1.txt\nfile2.txt", IsError: false})
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
	assertEventType(t, events[0], "tool_result_message")
	ev := events[0]
	if ev["toolCallId"] != "tool_abc" || ev["toolName"] != "bash" || ev["content"] != "file1.txt\nfile2.txt" || ev["isError"] != false {
		t.Fatalf("unexpected tool result: %+v", ev)
	}
	assertEventType(t, events[1], "tool_execution_end")
}

func TestAdapterResultEventMetadata(t *testing.T) {
	a := NewAdapter()
	a.HandleEvent(&SystemEvent{Model: "claude-sonnet-4-20250514"})
	events := a.HandleEvent(&ResultEvent{
		InputTokens:  500,
		OutputTokens: 200,
		TotalCostUSD: 0.05,
		DurationMs:   3000,
		NumTurns:     1,
		StopReason:   "end_turn",
	})
	if len(events) != 2 {
		t.Fatalf("expected 2 events (metadata + idle heartbeat), got %d", len(events))
	}
	ev := events[0]
	assertEventType(t, ev, "session_metadata_update")
	if ev["costUSD"] != 0.05 {
		t.Fatalf("unexpected costUSD: %+v", ev)
	}
	usage, ok := ev["usage"].(map[string]any)
	if !ok || usage["inputTokens"] != 500 || usage["outputTokens"] != 200 {
		t.Fatalf("unexpected usage: %+v", ev["usage"])
	}
	if ev["durationMs"] != 3000 || ev["numTurns"] != 1 || ev["stopReason"] != "end_turn" {
		t.Fatalf("unexpected metadata fields: %+v", ev)
	}
}

func TestAdapterFullConversationFlow(t *testing.T) {
	a := NewAdapter()
	var relayed []RelayEvent
	collect := func(in []RelayEvent) { relayed = append(relayed, in...) }

	collect(a.HandleEvent(&SystemEvent{Cwd: "/tmp", Model: "claude-sonnet-4-20250514"}))
	collect(a.HandleEvent(&MessageStart{MessageID: "msg_01", Role: "assistant"}))
	collect(a.HandleEvent(&ContentBlockStart{Index: 0, BlockType: "text"}))
	collect(a.HandleEvent(&ContentBlockDelta{Index: 0, DeltaType: "text_delta", Text: "Hello"}))
	collect(a.HandleEvent(&ContentBlockDelta{Index: 0, DeltaType: "text_delta", Text: " world"}))
	collect(a.HandleEvent(&ContentBlockStop{Index: 0}))
	collect(a.HandleEvent(&MessageStop{}))
	collect(a.HandleEvent(&AssistantMessage{Message: mustJSON(t, map[string]any{
		"id":      "msg_01",
		"role":    "assistant",
		"content": []map[string]any{{"type": "text", "text": "Hello world"}},
	})}))
	collect(a.HandleEvent(&ToolUseEvent{ToolID: "tool_abc", Name: "bash", Input: mustJSON(t, map[string]any{"command": "ls"})}))
	collect(a.HandleEvent(&ToolResultEvent{ToolID: "tool_abc", Content: "file1.txt\nfile2.txt", IsError: false}))
	collect(a.HandleEvent(&ResultEvent{InputTokens: 500, OutputTokens: 200, TotalCostUSD: 0.05}))

	// Expected event sequence:
	// 0: heartbeat (from SystemEvent)
	// 1: session_active (initial snapshot)
	// 2: message_start (from MessageStart)
	// 3: message_update (text_delta "Hello" — streaming)
	// 4: message_update (text_delta " world" — streaming)
	// 5: message_update (final AssistantMessage)
	// 6: message_end (finalized)
	// 7: message_update (ToolUseEvent)
	// 8: tool_result_message
	// 9: tool_execution_end
	// 10: session_active (final snapshot)
	// 11: session_metadata_update
	// 12: heartbeat (idle)
	if len(relayed) != 13 {
		types := make([]string, len(relayed))
		for i, ev := range relayed {
			types[i], _ = ev["type"].(string)
		}
		t.Fatalf("expected 13 relay events, got %d: %v", len(relayed), types)
	}

	assertEventType(t, relayed[0], "heartbeat")
	assertEventType(t, relayed[1], "session_active")
	assertEventType(t, relayed[2], "message_start")
	assertEventType(t, relayed[3], "message_update")  // streaming delta
	assertEventType(t, relayed[4], "message_update")  // streaming delta
	assertEventType(t, relayed[5], "message_update")  // final assistant
	assertEventType(t, relayed[6], "message_end")
	assertEventType(t, relayed[7], "message_update")  // tool_use
	assertEventType(t, relayed[8], "tool_result_message")
	assertEventType(t, relayed[9], "tool_execution_end")
	assertEventType(t, relayed[10], "session_active") // final snapshot
	assertEventType(t, relayed[11], "session_metadata_update")
	assertEventType(t, relayed[12], "heartbeat")

	// Verify final message content via message field
	msg := relayed[5]["message"].(map[string]any)
	content := getContent(t, msg)
	if len(content) != 1 || content[0]["text"] != "Hello world" {
		t.Fatalf("unexpected final assistant content: %+v", content)
	}

	// Verify idle heartbeat
	if relayed[12]["active"] != false {
		t.Fatal("expected final heartbeat active=false")
	}
}

func TestAdapterParseErrorNoOutput(t *testing.T) {
	a := NewAdapter()
	if got := a.HandleEvent(&ParseError{Message: "bad json"}); len(got) != 0 {
		t.Fatalf("expected no events, got %+v", got)
	}
}

func TestAdapterUnknownEventNoOutput(t *testing.T) {
	a := NewAdapter()
	if got := a.HandleEvent(&UnknownEvent{RawType: "mystery"}); len(got) != 0 {
		t.Fatalf("expected no events, got %+v", got)
	}
}

func assertEventType(t *testing.T, ev RelayEvent, expected string) {
	t.Helper()
	if ev["type"] != expected {
		t.Fatalf("expected type %q, got %q (%+v)", expected, ev["type"], ev)
	}
}

func getContent(t *testing.T, ev RelayEvent) []map[string]any {
	t.Helper()
	raw, ok := ev["content"]
	if !ok {
		t.Fatalf("content missing: %+v", ev)
	}
	content, ok := raw.([]map[string]any)
	if ok {
		return content
	}
	asAny, ok := raw.([]any)
	if !ok {
		t.Fatalf("unexpected content type %T in %+v", raw, ev)
	}
	out := make([]map[string]any, 0, len(asAny))
	for _, item := range asAny {
		block, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("unexpected block type %T", item)
		}
		out = append(out, block)
	}
	return out
}

func TestAdapterUserMessageToolResult(t *testing.T) {
	a := NewAdapter()
	a.HandleEvent(&AssistantMessage{Message: mustJSON(t, map[string]any{
		"id":   "msg_01",
		"role": "assistant",
		"content": []map[string]any{
			{"type": "tool_use", "id": "toolu_abc", "name": "Bash", "input": map[string]any{"command": "ls"}},
		},
	})})
	// Now emits tool_result_message + tool_execution_end
	events := a.HandleEvent(&UserMessage{
		ToolUseID: "toolu_abc",
		Content:   "file1.txt\nfile2.txt",
		IsError:   false,
	})
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
	assertEventType(t, events[0], "tool_result_message")
	if events[0]["toolCallId"] != "toolu_abc" || events[0]["toolName"] != "Bash" {
		t.Fatalf("unexpected tool result: %+v", events[0])
	}
	assertEventType(t, events[1], "tool_execution_end")
}

func TestAdapterRateLimitEventNoOutput(t *testing.T) {
	a := NewAdapter()
	events := a.HandleEvent(&RateLimitEvent{Status: "allowed", LimitType: "five_hour"})
	if len(events) != 0 {
		t.Fatalf("expected 0 events for rate_limit_event, got %d", len(events))
	}
}

func TestAdapterEmptyAssistantSkipped(t *testing.T) {
	a := NewAdapter()
	events := a.HandleEvent(&AssistantMessage{Message: mustJSON(t, map[string]any{
		"id": "msg_01", "role": "assistant", "content": []any{},
	})})
	if len(events) != 0 {
		t.Fatalf("expected 0 events for empty assistant, got %d", len(events))
	}
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal json: %v", err)
	}
	return b
}
