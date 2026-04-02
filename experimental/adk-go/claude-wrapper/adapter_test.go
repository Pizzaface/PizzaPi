package claudewrapper

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
	if events[0]["type"] != "heartbeat" {
		t.Fatalf("unexpected first event type: %+v", events[0])
	}
	if events[1]["type"] != "session_active" {
		t.Fatalf("unexpected second event type: %+v", events[1])
	}
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

func TestAdapterStreamingTextMessageUpdate(t *testing.T) {
	a := NewAdapter()
	if got := a.HandleEvent(&MessageStart{MessageID: "msg_01", Role: "assistant"}); len(got) != 0 {
		t.Fatalf("expected no events, got %+v", got)
	}
	if got := a.HandleEvent(&ContentBlockStart{Index: 0, BlockType: "text"}); len(got) != 0 {
		t.Fatalf("expected no events, got %+v", got)
	}

	events := a.HandleEvent(&ContentBlockDelta{Index: 0, DeltaType: "text_delta", Text: "Hello"})
	assertSingleTextUpdate(t, events, "msg_01", "Hello")

	events = a.HandleEvent(&ContentBlockDelta{Index: 0, DeltaType: "text_delta", Text: " world"})
	assertSingleTextUpdate(t, events, "msg_01", "Hello world")
}

func TestAdapterToolCallAssembly(t *testing.T) {
	a := NewAdapter()
	a.HandleEvent(&MessageStart{MessageID: "msg_01"})
	if got := a.HandleEvent(&ContentBlockStart{Index: 1, BlockType: "tool_use", ToolID: "tool_abc", ToolName: "bash"}); len(got) != 0 {
		t.Fatalf("expected no events, got %+v", got)
	}
	if got := a.HandleEvent(&ContentBlockDelta{Index: 1, DeltaType: "input_json_delta", PartialJSON: `{"command":"ls"}`}); len(got) != 0 {
		t.Fatalf("expected no events, got %+v", got)
	}
	if got := a.HandleEvent(&ContentBlockStop{Index: 1}); len(got) != 0 {
		t.Fatalf("expected no events, got %+v", got)
	}

	events := a.HandleEvent(&AssistantMessage{Message: mustJSON(t, map[string]any{
		"id":   "msg_01",
		"role": "assistant",
		"content": []map[string]any{
			{"type": "tool_use", "id": "tool_abc", "name": "bash", "input": map[string]any{"command": "ls"}},
		},
	})})
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	content := getContent(t, events[0])
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
	events := a.HandleEvent(&ToolResultEvent{ToolID: "tool_abc", Content: "file1.txt\nfile2.txt", IsError: false})
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	ev := events[0]
	if ev["type"] != "tool_result_message" || ev["toolCallId"] != "tool_abc" || ev["toolName"] != "bash" || ev["content"] != "file1.txt\nfile2.txt" || ev["isError"] != false {
		t.Fatalf("unexpected tool result event: %+v", ev)
	}
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
	if ev["type"] != "session_metadata_update" || ev["costUSD"] != 0.05 {
		t.Fatalf("unexpected metadata event: %+v", ev)
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
	appendEvents := func(in []RelayEvent) { relayed = append(relayed, in...) }

	appendEvents(a.HandleEvent(&SystemEvent{Cwd: "/tmp", Model: "claude-sonnet-4-20250514"}))
	appendEvents(a.HandleEvent(&MessageStart{MessageID: "msg_01", Role: "assistant"}))
	appendEvents(a.HandleEvent(&ContentBlockStart{Index: 0, BlockType: "text"}))
	appendEvents(a.HandleEvent(&ContentBlockDelta{Index: 0, DeltaType: "text_delta", Text: "Hello"}))
	appendEvents(a.HandleEvent(&ContentBlockDelta{Index: 0, DeltaType: "text_delta", Text: " world"}))
	appendEvents(a.HandleEvent(&ContentBlockStop{Index: 0}))
	appendEvents(a.HandleEvent(&MessageStop{}))
	appendEvents(a.HandleEvent(&AssistantMessage{Message: mustJSON(t, map[string]any{
		"id":   "msg_01",
		"role": "assistant",
		"content": []map[string]any{{"type": "text", "text": "Hello world"}},
	})}))
	appendEvents(a.HandleEvent(&ToolUseEvent{ToolID: "tool_abc", Name: "bash", Input: mustJSON(t, map[string]any{"command": "ls"})}))
	appendEvents(a.HandleEvent(&ToolResultEvent{ToolID: "tool_abc", Content: "file1.txt\nfile2.txt", IsError: false}))
	appendEvents(a.HandleEvent(&ResultEvent{InputTokens: 500, OutputTokens: 200, TotalCostUSD: 0.05}))

	if len(relayed) != 10 {
		t.Fatalf("expected 10 relay events, got %d: %+v", len(relayed), relayed)
	}
	assertEventType(t, relayed[0], "heartbeat")
	assertEventType(t, relayed[1], "session_active")    // initial empty snapshot
	assertEventType(t, relayed[2], "message_update")
	assertEventType(t, relayed[3], "message_update")
	assertEventType(t, relayed[4], "message_update")    // final assistant message
	assertEventType(t, relayed[5], "message_update")    // tool_use block
	assertEventType(t, relayed[6], "tool_result_message")
	assertEventType(t, relayed[7], "session_active")    // final snapshot with messages
	assertEventType(t, relayed[8], "session_metadata_update")
	assertEventType(t, relayed[9], "heartbeat")         // active=false (idle)
	content := getContent(t, relayed[4])
	if len(content) != 1 || content[0]["text"] != "Hello world" {
		t.Fatalf("unexpected final assistant content: %+v", content)
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

func assertSingleTextUpdate(t *testing.T, events []RelayEvent, messageID, expectedText string) {
	t.Helper()
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	ev := events[0]
	assertEventType(t, ev, "message_update")
	if ev["messageId"] != messageID {
		t.Fatalf("unexpected messageId: %+v", ev)
	}
	content := getContent(t, ev)
	if len(content) != 1 || content[0]["type"] != "text" || content[0]["text"] != expectedText {
		t.Fatalf("unexpected content: %+v", content)
	}
}

func assertEventType(t *testing.T, ev RelayEvent, expected string) {
	t.Helper()
	if ev["type"] != expected {
		t.Fatalf("expected type %q, got %+v", expected, ev)
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
	// Register tool name first via a ToolUseEvent
	a.HandleEvent(&AssistantMessage{Message: mustJSON(t, map[string]any{
		"id":   "msg_01",
		"role": "assistant",
		"content": []map[string]any{
			{"type": "tool_use", "id": "toolu_abc", "name": "Bash", "input": map[string]any{"command": "ls"}},
		},
	})})
	events := a.HandleEvent(&UserMessage{
		ToolUseID: "toolu_abc",
		Content:   "file1.txt\nfile2.txt",
		IsError:   false,
	})
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	ev := events[0]
	if ev["type"] != "tool_result_message" {
		t.Fatalf("unexpected type: %+v", ev)
	}
	if ev["toolCallId"] != "toolu_abc" || ev["toolName"] != "Bash" {
		t.Fatalf("unexpected tool result: %+v", ev)
	}
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
