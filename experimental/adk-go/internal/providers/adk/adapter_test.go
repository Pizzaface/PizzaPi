package adk

import (
	"testing"

	"google.golang.org/adk/model"
	"google.golang.org/adk/session"
	"google.golang.org/genai"
)

func newTestAdapter() *Adapter {
	return NewAdapter(AdapterModel{Provider: "google", ID: "gemini-2.5-flash"}, "/tmp/test")
}

func newEvent(role string, parts ...*genai.Part) *session.Event {
	return &session.Event{
		LLMResponse: model.LLMResponse{
			Content: &genai.Content{
				Role:  role,
				Parts: parts,
			},
		},
	}
}

func newPartialEvent(role string, parts ...*genai.Part) *session.Event {
	ev := newEvent(role, parts...)
	ev.Partial = true
	return ev
}

func findByType(events []RelayEvent, typ string) RelayEvent {
	for _, ev := range events {
		if ev["type"] == typ {
			return ev
		}
	}
	return nil
}

func findAllByType(events []RelayEvent, typ string) []RelayEvent {
	var out []RelayEvent
	for _, ev := range events {
		if ev["type"] == typ {
			out = append(out, ev)
		}
	}
	return out
}

func requireField(t *testing.T, ev RelayEvent, key string, expected any) {
	t.Helper()
	val, ok := ev[key]
	if !ok {
		t.Fatalf("missing field %q", key)
	}
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
		case int32:
			if int(v) != e {
				t.Fatalf("field %q: expected %v, got %v", key, expected, val)
			}
			return
		}
	}
	if val != expected {
		t.Fatalf("field %q: expected %v (%T), got %v (%T)", key, expected, expected, val, val)
	}
}

func requireFieldExists(t *testing.T, ev RelayEvent, key string) {
	t.Helper()
	if _, ok := ev[key]; !ok {
		t.Fatalf("missing field %q", key)
	}
}

func requireMapField(t *testing.T, ev RelayEvent, key string) map[string]any {
	t.Helper()
	val, ok := ev[key]
	if !ok {
		t.Fatalf("missing field %q", key)
	}
	m, ok := val.(map[string]any)
	if !ok {
		t.Fatalf("field %q should be a map, got %T", key, val)
	}
	return m
}

// --- Initial event tests ---

func TestAdapter_FirstEventEmitsHeartbeatAndSessionActive(t *testing.T) {
	a := newTestAdapter()
	ev := newEvent("model", genai.NewPartFromText("Hello"))

	events := a.HandleEvent(ev)

	hb := findByType(events, "heartbeat")
	if hb == nil {
		t.Fatal("missing heartbeat on first event")
	}
	requireField(t, hb, "active", true)
	requireField(t, hb, "isCompacting", false)
	requireFieldExists(t, hb, "ts")

	m := requireMapField(t, hb, "model")
	requireField(t, m, "provider", "google")
	requireField(t, m, "id", "gemini-2.5-flash")

	sa := findByType(events, "session_active")
	if sa == nil {
		t.Fatal("missing session_active on first event")
	}
	state := requireMapField(t, sa, "state")
	requireFieldExists(t, state, "messages")
	requireFieldExists(t, state, "model")
}

func TestAdapter_SecondEventNoHeartbeat(t *testing.T) {
	a := newTestAdapter()
	a.HandleEvent(newEvent("model", genai.NewPartFromText("First")))

	events := a.HandleEvent(newEvent("model", genai.NewPartFromText("Second")))
	hb := findByType(events, "heartbeat")
	if hb != nil {
		t.Error("should not emit heartbeat on subsequent events")
	}
}

// --- Streaming text delta tests ---

func TestAdapter_PartialTextEmitsStreamingDelta(t *testing.T) {
	a := newTestAdapter()
	ev := newPartialEvent("model", genai.NewPartFromText("Hello"))

	events := a.HandleEvent(ev)

	mu := findByType(events, "message_update")
	if mu == nil {
		t.Fatal("missing message_update for partial text")
	}

	ame, ok := mu["assistantMessageEvent"].(map[string]any)
	if !ok {
		t.Fatal("message_update missing assistantMessageEvent for streaming")
	}

	if ame["type"] != "text_delta" {
		t.Errorf("expected type text_delta, got %v", ame["type"])
	}
	requireFieldExists(t, RelayEvent(ame), "partial")
	requireFieldExists(t, RelayEvent(ame), "delta")

	partial := ame["partial"].(map[string]any)
	if partial["role"] != "assistant" {
		t.Errorf("expected role assistant, got %v", partial["role"])
	}
}

// --- Final message tests ---

func TestAdapter_FinalTextEmitsMessageLifecycle(t *testing.T) {
	a := newTestAdapter()
	ev := newEvent("model", genai.NewPartFromText("Hello world"))

	events := a.HandleEvent(ev)

	ms := findByType(events, "message_start")
	if ms == nil {
		t.Fatal("missing message_start")
	}
	msg := requireMapField(t, ms, "message")
	requireField(t, msg, "role", "assistant")

	mu := findByType(events, "message_update")
	if mu == nil {
		t.Fatal("missing message_update")
	}
	// Final message_update has "message" field (not assistantMessageEvent)
	if _, has := mu["message"]; !has {
		t.Fatal("final message_update should have 'message' field")
	}

	me := findByType(events, "message_end")
	if me == nil {
		t.Fatal("missing message_end")
	}
	endMsg := requireMapField(t, me, "message")
	requireFieldExists(t, endMsg, "timestamp")
}

// --- Function call tests ---

func TestAdapter_FunctionCallEmitsToolExecutionStart(t *testing.T) {
	a := newTestAdapter()
	ev := newEvent("model", &genai.Part{
		FunctionCall: &genai.FunctionCall{
			ID:   "call_123",
			Name: "bash",
			Args: map[string]any{"command": "ls"},
		},
	})

	events := a.HandleEvent(ev)

	tes := findByType(events, "tool_execution_start")
	if tes == nil {
		t.Fatal("missing tool_execution_start")
	}
	requireField(t, tes, "toolCallId", "call_123")
	requireField(t, tes, "toolName", "bash")
}

func TestAdapter_PartialFunctionCallEmitsToolStart(t *testing.T) {
	a := newTestAdapter()
	ev := newPartialEvent("model", &genai.Part{
		FunctionCall: &genai.FunctionCall{
			ID:   "call_456",
			Name: "read",
		},
	})

	events := a.HandleEvent(ev)

	tes := findByType(events, "tool_execution_start")
	if tes == nil {
		t.Fatal("missing tool_execution_start from partial")
	}
	requireField(t, tes, "toolCallId", "call_456")
	requireField(t, tes, "toolName", "read")
}

// --- Function response tests ---

func TestAdapter_FunctionResponseEmitsToolResult(t *testing.T) {
	a := newTestAdapter()
	// First register the tool name
	a.toolNamesByID["call_789"] = "bash"

	ev := newEvent("user", &genai.Part{
		FunctionResponse: &genai.FunctionResponse{
			ID:       "call_789",
			Name:     "bash",
			Response: map[string]any{"output": "file1.txt\nfile2.txt"},
		},
	})

	events := a.HandleEvent(ev)

	tr := findByType(events, "tool_result_message")
	if tr == nil {
		t.Fatal("missing tool_result_message")
	}
	requireField(t, tr, "role", "tool_result")
	requireField(t, tr, "toolCallId", "call_789")
	requireField(t, tr, "toolName", "bash")
	requireField(t, tr, "content", "file1.txt\nfile2.txt")
	requireField(t, tr, "isError", false)

	tee := findByType(events, "tool_execution_end")
	if tee == nil {
		t.Fatal("missing tool_execution_end")
	}
	requireField(t, tee, "toolCallId", "call_789")
}

// --- Turn end tests ---

func TestAdapter_HandleTurnEnd(t *testing.T) {
	a := newTestAdapter()
	// Simulate some messages first
	a.AddUserMessage("Hello")
	a.started = true

	events := a.HandleTurnEnd(500, 200, 0.05, 1, "end_turn")

	sa := findByType(events, "session_active")
	if sa == nil {
		t.Fatal("missing session_active on turn end")
	}

	smu := findByType(events, "session_metadata_update")
	if smu == nil {
		t.Fatal("missing session_metadata_update")
	}
	requireFieldExists(t, smu, "model")
	requireFieldExists(t, smu, "usage")

	hb := findByType(events, "heartbeat")
	if hb == nil {
		t.Fatal("missing heartbeat on turn end")
	}
	requireField(t, hb, "active", false)
}

// --- User message accumulation ---

func TestAdapter_AddUserMessage(t *testing.T) {
	a := newTestAdapter()
	a.AddUserMessage("Hello")

	if len(a.messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(a.messages))
	}
	msg := a.messages[0]
	if msg["role"] != "user" {
		t.Errorf("expected role user, got %v", msg["role"])
	}
}

// --- FormatFunctionResponse ---

func TestFormatFunctionResponse_OutputKey(t *testing.T) {
	result := formatFunctionResponse(map[string]any{"output": "hello"})
	if result != "hello" {
		t.Errorf("expected 'hello', got %q", result)
	}
}

func TestFormatFunctionResponse_ResultKey(t *testing.T) {
	result := formatFunctionResponse(map[string]any{"result": "world"})
	if result != "world" {
		t.Errorf("expected 'world', got %q", result)
	}
}

func TestFormatFunctionResponse_Nil(t *testing.T) {
	result := formatFunctionResponse(nil)
	if result != "" {
		t.Errorf("expected empty, got %q", result)
	}
}

// --- Full conversation flow ---

func TestAdapter_FullConversationEventSequence(t *testing.T) {
	a := newTestAdapter()
	a.AddUserMessage("Tell me a joke")
	var relayed []RelayEvent
	collect := func(evts []RelayEvent) { relayed = append(relayed, evts...) }

	// 1. Streaming text delta
	collect(a.HandleEvent(newPartialEvent("model", genai.NewPartFromText("Why"))))
	collect(a.HandleEvent(newPartialEvent("model", genai.NewPartFromText("Why did the"))))

	// 2. Final text message
	collect(a.HandleEvent(newEvent("model", genai.NewPartFromText("Why did the chicken cross the road?"))))

	// 3. Function call
	collect(a.HandleEvent(newEvent("model", &genai.Part{
		FunctionCall: &genai.FunctionCall{ID: "t1", Name: "bash", Args: map[string]any{"command": "echo hi"}},
	})))

	// 4. Function response
	collect(a.HandleEvent(newEvent("user", &genai.Part{
		FunctionResponse: &genai.FunctionResponse{ID: "t1", Name: "bash", Response: map[string]any{"output": "hi\n"}},
	})))

	// 5. Turn end
	collect(a.HandleTurnEnd(500, 200, 0.05, 1, "end_turn"))

	// Verify critical event types present
	typeSet := map[string]int{}
	for _, ev := range relayed {
		if t, ok := ev["type"].(string); ok {
			typeSet[t]++
		}
	}

	required := []string{
		"heartbeat", "session_active", "message_update", "message_start",
		"message_end", "tool_execution_start", "tool_result_message",
		"tool_execution_end", "session_metadata_update",
	}
	for _, req := range required {
		if typeSet[req] == 0 {
			t.Errorf("missing required event type %q in full conversation flow", req)
		}
	}

	// Verify final heartbeat is idle
	hbs := findAllByType(relayed, "heartbeat")
	lastHB := hbs[len(hbs)-1]
	if lastHB["active"] != false {
		t.Error("expected final heartbeat with active=false")
	}
}
