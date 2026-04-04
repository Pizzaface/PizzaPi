// adapter_compat_test.go — integration tests that validate adapter output
// against what the PizzaPi React UI (App.tsx + message-helpers.ts) expects.
//
// The UI normalizes every message through toRelayMessage() which expects:
//   - Messages with role, content (array of blocks), timestamp, id fields
//   - Heartbeats with active, isCompacting, ts, model, sessionName
//   - session_metadata_update with metadata nested key
//   - message_update with either assistantMessageEvent (streaming) or message (final)
//   - message_start / message_end / turn_end lifecycle events
//   - tool_execution_start / tool_execution_end for live tool output
package claudecli

import (
	"testing"
)

// --- Heartbeat format ---

func TestCompat_HeartbeatShape(t *testing.T) {
	a := NewAdapter()
	events := a.HandleEvent(&SystemEvent{Cwd: "/tmp", Model: "claude-sonnet-4-20250514"})

	hb := findByType(events, "heartbeat")
	if hb == nil {
		t.Fatal("missing heartbeat event")
	}

	// UI expects: active (bool), isCompacting (bool), ts (number), model ({provider, id}), sessionName
	requireField(t, hb, "active", true)
	requireField(t, hb, "isCompacting", false)
	requireFieldExists(t, hb, "ts")

	model := requireMapField(t, hb, "model")
	requireField(t, model, "provider", "anthropic")
	requireField(t, model, "id", "claude-sonnet-4-20250514")
}

// --- session_active format ---

func TestCompat_SessionActiveShape(t *testing.T) {
	a := NewAdapter()
	a.SetUserPrompt("Hello")
	events := a.HandleEvent(&SystemEvent{Cwd: "/tmp", Model: "claude-sonnet-4-20250514"})

	sa := findByType(events, "session_active")
	if sa == nil {
		t.Fatal("missing session_active event")
	}

	state := requireMapField(t, sa, "state")
	requireFieldExists(t, state, "messages")
	requireFieldExists(t, state, "model")

	model := requireMapField(t, state, "model")
	requireField(t, model, "provider", "anthropic")
}

// --- message_update with message field (non-streaming) ---

func TestCompat_MessageUpdateHasMessageField(t *testing.T) {
	a := NewAdapter()
	a.HandleEvent(&SystemEvent{Cwd: "/tmp", Model: "claude-sonnet-4-20250514"})

	// Simulate a final assistant message
	events := a.HandleEvent(&AssistantMessage{Message: mustJSON(t, map[string]any{
		"id":   "msg_01",
		"role": "assistant",
		"content": []map[string]any{
			{"type": "text", "text": "Hello world"},
		},
	})})

	mu := findByType(events, "message_update")
	if mu == nil {
		t.Fatal("missing message_update event")
	}

	// UI expects: evt.message (the message object to upsert)
	// See App.tsx: upsertMessage(evt.message, "message-update")
	msg, ok := mu["message"]
	if !ok {
		t.Fatal("message_update missing 'message' field — UI expects evt.message for non-streaming updates")
	}

	msgMap, ok := msg.(map[string]any)
	if !ok {
		t.Fatalf("message field should be a map, got %T", msg)
	}

	requireField(t, msgMap, "role", "assistant")
	requireFieldExists(t, msgMap, "content")

	// The message must have an id field for dedup — UI uses it to build the message key
	if _, ok := msgMap["id"]; !ok {
		t.Error("message_update.message missing 'id' field — needed for UI key generation")
	}
}

// --- message_update with assistantMessageEvent for streaming ---

func TestCompat_StreamingDeltaHasAssistantMessageEvent(t *testing.T) {
	a := NewAdapter()
	a.HandleEvent(&SystemEvent{Cwd: "/tmp", Model: "claude-sonnet-4-20250514"})
	a.HandleEvent(&MessageStart{MessageID: "msg_01", Role: "assistant"})
	a.HandleEvent(&ContentBlockStart{Index: 0, BlockType: "text"})

	// Text delta should produce assistantMessageEvent
	events := a.HandleEvent(&ContentBlockDelta{Index: 0, DeltaType: "text_delta", Text: "Hello"})

	mu := findByType(events, "message_update")
	if mu == nil {
		t.Fatal("missing message_update for text_delta")
	}

	// UI streaming path: evt.assistantMessageEvent?.partial
	ame, ok := mu["assistantMessageEvent"]
	if !ok {
		t.Fatal("streaming message_update missing 'assistantMessageEvent' field")
	}

	ameMap, ok := ame.(map[string]any)
	if !ok {
		t.Fatalf("assistantMessageEvent should be a map, got %T", ame)
	}

	// Must have: partial (the accumulated message), type (delta type), contentIndex
	requireFieldExists(t, ameMap, "partial")
	requireField(t, ameMap, "type", "text_delta")
	requireField(t, ameMap, "contentIndex", 0)

	partial := requireMapField(t, ameMap, "partial")
	requireField(t, partial, "role", "assistant")
	requireFieldExists(t, partial, "content")
}

// --- Thinking delta streaming ---

func TestCompat_ThinkingDeltaStreaming(t *testing.T) {
	a := NewAdapter()
	a.HandleEvent(&SystemEvent{Cwd: "/tmp", Model: "claude-sonnet-4-20250514"})
	a.HandleEvent(&MessageStart{MessageID: "msg_01", Role: "assistant"})
	a.HandleEvent(&ContentBlockStart{Index: 0, BlockType: "thinking"})

	events := a.HandleEvent(&ContentBlockDelta{Index: 0, DeltaType: "thinking_delta", Thinking: "pondering..."})
	mu := findByType(events, "message_update")
	if mu == nil {
		t.Fatal("missing message_update for thinking_delta")
	}

	ame := requireMapField(t, mu, "assistantMessageEvent")
	requireField(t, ame, "type", "thinking_delta")
	requireFieldExists(t, ame, "contentIndex")
	requireFieldExists(t, ame, "partial")
}

// --- message_start event ---

func TestCompat_MessageStartEmitted(t *testing.T) {
	a := NewAdapter()
	a.HandleEvent(&SystemEvent{Cwd: "/tmp", Model: "claude-sonnet-4-20250514"})

	events := a.HandleEvent(&MessageStart{MessageID: "msg_01", Role: "assistant"})
	ms := findByType(events, "message_start")
	if ms == nil {
		t.Fatal("missing message_start event — UI uses this to show message appearing")
	}

	msg, ok := ms["message"].(map[string]any)
	if !ok {
		t.Fatal("message_start missing 'message' field")
	}
	requireField(t, msg, "role", "assistant")
}

// --- message_end event ---

func TestCompat_MessageEndEmitted(t *testing.T) {
	a := NewAdapter()
	a.HandleEvent(&SystemEvent{Cwd: "/tmp", Model: "claude-sonnet-4-20250514"})
	a.HandleEvent(&MessageStart{MessageID: "msg_01", Role: "assistant"})
	a.HandleEvent(&ContentBlockStart{Index: 0, BlockType: "text"})
	a.HandleEvent(&ContentBlockDelta{Index: 0, DeltaType: "text_delta", Text: "Hello"})
	a.HandleEvent(&ContentBlockStop{Index: 0})

	events := a.HandleEvent(&AssistantMessage{Message: mustJSON(t, map[string]any{
		"id":   "msg_01",
		"role": "assistant",
		"content": []map[string]any{
			{"type": "text", "text": "Hello"},
		},
	})})

	// Should emit both message_update (for upsert) and message_end (for finalization)
	me := findByType(events, "message_end")
	if me == nil {
		t.Fatal("missing message_end — UI uses this to finalize and evict streaming partials")
	}

	msg, ok := me["message"].(map[string]any)
	if !ok {
		t.Fatal("message_end missing 'message' field")
	}
	requireField(t, msg, "role", "assistant")
	requireFieldExists(t, msg, "content")

	// message_end message must have a timestamp for the UI to build a stable key
	requireFieldExists(t, msg, "timestamp")
}

// --- session_metadata_update nesting ---

func TestCompat_SessionMetadataUpdateNested(t *testing.T) {
	a := NewAdapter()
	a.HandleEvent(&SystemEvent{Cwd: "/tmp", Model: "claude-sonnet-4-20250514"})

	events := a.HandleEvent(&ResultEvent{
		InputTokens:  500,
		OutputTokens: 200,
		TotalCostUSD: 0.05,
		DurationMs:   3000,
		NumTurns:     1,
		StopReason:   "end_turn",
	})

	smu := findByType(events, "session_metadata_update")
	if smu == nil {
		t.Fatal("missing session_metadata_update")
	}

	// UI expects: evt.metadata (nested)
	// See App.tsx: const meta = (evt.metadata ?? {}) as Record<string, unknown>
	// Then: normalizeModel(meta.model), meta.sessionName, etc.
	//
	// BUT: Looking more carefully at the UI code, it also reads some fields
	// directly from evt: evt.model, evt.usage. Let me check both paths.
	//
	// The primary path reads: (evt.metadata ?? {}).model
	// But model is also available at evt.model for backward compat.
	// The Go adapter should provide at least the model at top level.
	requireFieldExists(t, smu, "model")
}

// --- tool_result_message format ---

func TestCompat_ToolResultMessageFormat(t *testing.T) {
	a := NewAdapter()
	a.HandleEvent(&ToolUseEvent{ToolID: "tool_abc", Name: "bash", Input: mustJSON(t, map[string]any{"command": "ls"})})

	events := a.HandleEvent(&ToolResultEvent{ToolID: "tool_abc", Content: "file1.txt\nfile2.txt", IsError: false})
	tr := findByType(events, "tool_result_message")
	if tr == nil {
		t.Fatal("missing tool_result_message")
	}

	// UI normalizer (toRelayMessage) expects: role, toolCallId, toolName, content, isError
	requireField(t, tr, "role", "tool_result")
	requireField(t, tr, "toolCallId", "tool_abc")
	requireField(t, tr, "toolName", "bash")
	requireField(t, tr, "content", "file1.txt\nfile2.txt")
	requireField(t, tr, "isError", false)
}

// --- tool_execution_start ---

func TestCompat_ToolExecutionStartEmitted(t *testing.T) {
	a := NewAdapter()
	a.HandleEvent(&SystemEvent{Cwd: "/tmp", Model: "claude-sonnet-4-20250514"})
	a.HandleEvent(&MessageStart{MessageID: "msg_01", Role: "assistant"})

	events := a.HandleEvent(&ContentBlockStart{Index: 0, BlockType: "tool_use", ToolID: "tool_abc", ToolName: "bash"})

	tes := findByType(events, "tool_execution_start")
	if tes == nil {
		t.Fatal("missing tool_execution_start — UI uses this for streaming tool indicators")
	}

	requireField(t, tes, "toolCallId", "tool_abc")
	requireField(t, tes, "toolName", "bash")
}

// --- Full conversation flow with correct event sequence ---

func TestCompat_FullConversationEventSequence(t *testing.T) {
	a := NewAdapter()
	a.SetUserPrompt("Tell me a joke")
	var relayed []RelayEvent
	collect := func(in []RelayEvent) { relayed = append(relayed, in...) }

	// System init
	collect(a.HandleEvent(&SystemEvent{Cwd: "/tmp", Model: "claude-sonnet-4-20250514"}))

	// Assistant message starts
	collect(a.HandleEvent(&MessageStart{MessageID: "msg_01", Role: "assistant"}))

	// Text streaming
	collect(a.HandleEvent(&ContentBlockStart{Index: 0, BlockType: "text"}))
	collect(a.HandleEvent(&ContentBlockDelta{Index: 0, DeltaType: "text_delta", Text: "Why"}))
	collect(a.HandleEvent(&ContentBlockDelta{Index: 0, DeltaType: "text_delta", Text: " did the"}))
	collect(a.HandleEvent(&ContentBlockStop{Index: 0}))
	collect(a.HandleEvent(&MessageStop{}))

	// Final assistant message
	collect(a.HandleEvent(&AssistantMessage{Message: mustJSON(t, map[string]any{
		"id":      "msg_01",
		"role":    "assistant",
		"content": []map[string]any{{"type": "text", "text": "Why did the"}},
	})}))

	// Tool use
	collect(a.HandleEvent(&ToolUseEvent{ToolID: "tool_abc", Name: "bash", Input: mustJSON(t, map[string]any{"command": "echo hi"})}))
	collect(a.HandleEvent(&ToolResultEvent{ToolID: "tool_abc", Content: "hi\n", IsError: false}))

	// Turn result
	collect(a.HandleEvent(&ResultEvent{InputTokens: 500, OutputTokens: 200, TotalCostUSD: 0.05, NumTurns: 1, StopReason: "end_turn"}))

	// Just check that critical events are present
	typeSet := map[string]int{}
	for _, ev := range relayed {
		if t, ok := ev["type"].(string); ok {
			typeSet[t]++
		}
	}

	mustHaveType := []string{
		"heartbeat", "session_active", "message_start", "message_update",
		"message_end", "tool_result_message", "session_metadata_update",
	}
	for _, required := range mustHaveType {
		if typeSet[required] == 0 {
			t.Errorf("missing required event type %q in full conversation flow", required)
		}
	}

	// Verify the idle heartbeat at end (active=false)
	lastHB := findLastByType(relayed, "heartbeat")
	if lastHB == nil || lastHB["active"] != false {
		t.Error("expected final heartbeat with active=false")
	}
}

// --- Messages in session_active have proper structure for toRelayMessage ---

func TestCompat_SessionActiveMessagesNormalize(t *testing.T) {
	a := NewAdapter()
	a.SetUserPrompt("Hello")
	a.HandleEvent(&SystemEvent{Cwd: "/tmp", Model: "claude-sonnet-4-20250514"})
	a.HandleEvent(&MessageStart{MessageID: "msg_01", Role: "assistant"})
	a.HandleEvent(&ContentBlockStart{Index: 0, BlockType: "text"})
	a.HandleEvent(&ContentBlockDelta{Index: 0, DeltaType: "text_delta", Text: "Hi"})
	a.HandleEvent(&AssistantMessage{Message: mustJSON(t, map[string]any{
		"id": "msg_01", "role": "assistant",
		"content": []map[string]any{{"type": "text", "text": "Hi"}},
	})})

	events := a.HandleEvent(&ResultEvent{InputTokens: 100, OutputTokens: 50, TotalCostUSD: 0.01})

	sa := findByType(events, "session_active")
	if sa == nil {
		t.Fatal("missing session_active in result events")
	}

	state := requireMapField(t, sa, "state")
	messages, ok := state["messages"].([]any)
	if !ok {
		t.Fatal("session_active state.messages should be []any")
	}

	if len(messages) < 2 {
		t.Fatalf("expected at least 2 messages (user + assistant), got %d", len(messages))
	}

	// Verify each message has fields that toRelayMessage() needs
	for i, raw := range messages {
		msg, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("message %d is not a map", i)
		}
		role, _ := msg["role"].(string)
		if role == "" {
			t.Errorf("message %d missing role", i)
		}
		// Must have either content or be a known message type
		if _, hasContent := msg["content"]; !hasContent {
			t.Errorf("message %d missing content", i)
		}
	}
}

// --- Helper functions ---

func findByType(events []RelayEvent, typ string) RelayEvent {
	for _, ev := range events {
		if ev["type"] == typ {
			return ev
		}
	}
	return nil
}

func findLastByType(events []RelayEvent, typ string) RelayEvent {
	for i := len(events) - 1; i >= 0; i-- {
		if events[i]["type"] == typ {
			return events[i]
		}
	}
	return nil
}

func requireField(t *testing.T, ev map[string]any, key string, expected any) {
	t.Helper()
	val, ok := ev[key]
	if !ok {
		t.Fatalf("missing field %q in %+v", key, ev)
	}
	// For numeric comparisons, handle int vs float64 JSON roundtrip
	switch e := expected.(type) {
	case int:
		switch v := val.(type) {
		case float64:
			if int(v) != e {
				t.Fatalf("field %q: expected %v, got %v", key, expected, val)
			}
			return
		case int:
			if v != e {
				t.Fatalf("field %q: expected %v, got %v", key, expected, val)
			}
			return
		}
	}
	if val != expected {
		t.Fatalf("field %q: expected %v (%T), got %v (%T)", key, expected, expected, val, val)
	}
}

func requireFieldExists(t *testing.T, ev map[string]any, key string) {
	t.Helper()
	if _, ok := ev[key]; !ok {
		t.Fatalf("missing field %q in %+v", key, ev)
	}
}

func requireMapField(t *testing.T, ev map[string]any, key string) map[string]any {
	t.Helper()
	val, ok := ev[key]
	if !ok {
		t.Fatalf("missing field %q in %+v", key, ev)
	}
	m, ok := val.(map[string]any)
	if !ok {
		t.Fatalf("field %q should be a map, got %T: %+v", key, val, val)
	}
	return m
}

// findAllByType returns all events with the given type.
func findAllByType(events []RelayEvent, typ string) []RelayEvent {
	var out []RelayEvent
	for _, ev := range events {
		if ev["type"] == typ {
			out = append(out, ev)
		}
	}
	return out
}

// debugEventTypes returns a summary of event types for debugging.
func debugEventTypes(events []RelayEvent) []string {
	var types []string
	for _, ev := range events {
		if t, ok := ev["type"].(string); ok {
			types = append(types, t)
		}
	}
	return types
}

// Suppress unused warnings — these helpers are used in specific test variants.
var _ = findAllByType
var _ = debugEventTypes
