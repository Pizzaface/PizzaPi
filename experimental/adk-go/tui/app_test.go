package tui

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// TestModelDefaults verifies that a new App initialises with correct defaults.
func TestModelDefaults(t *testing.T) {
	app := New(nil)
	s := app.state

	if len(s.Messages) != 0 {
		t.Errorf("expected empty message buffer, got %d", len(s.Messages))
	}
	if s.ScrollOffset != 0 {
		t.Errorf("expected scroll offset 0, got %d", s.ScrollOffset)
	}
	if s.ActiveTools == nil {
		t.Error("expected non-nil ActiveTools map")
	}
}

// TestCtrlCQuit verifies ctrl+c quits.
func TestCtrlCQuit(t *testing.T) {
	app := New(nil)
	_, cmd := app.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	if cmd == nil {
		t.Fatal("expected a command, got nil")
	}
	msg := cmd()
	if _, ok := msg.(tea.QuitMsg); !ok {
		t.Errorf("expected tea.QuitMsg, got %T", msg)
	}
}

// TestEnterAppendsMessage verifies Enter appends input text.
func TestEnterAppendsMessage(t *testing.T) {
	app := New(nil)
	app.state.Input.SetValue("hello world")

	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyEnter})
	app = next.(App)

	if len(app.state.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(app.state.Messages))
	}
	if app.state.Messages[0].Text != "hello world" {
		t.Errorf("expected 'hello world', got %q", app.state.Messages[0].Text)
	}
	if app.state.Messages[0].Role != "user" {
		t.Errorf("expected role 'user', got %q", app.state.Messages[0].Role)
	}
}

// TestEnterEmptyNoMessage verifies blank input doesn't append.
func TestEnterEmptyNoMessage(t *testing.T) {
	app := New(nil)
	app.state.Input.SetValue("   ")

	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyEnter})
	app = next.(App)

	if len(app.state.Messages) != 0 {
		t.Errorf("expected no messages for blank input, got %d", len(app.state.Messages))
	}
}

// TestViewRendersWithoutPanic verifies View() works.
func TestViewRendersWithoutPanic(t *testing.T) {
	app := New(nil)
	next, _ := app.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	app = next.(App)

	out := app.View()
	if strings.TrimSpace(out) == "" {
		t.Error("expected non-empty view output")
	}
}

// TestScrollUp verifies scroll increases.
func TestScrollUp(t *testing.T) {
	app := New(nil)
	app.state.Messages = []DisplayMessage{
		{Role: "user", Text: "a"},
		{Role: "user", Text: "b"},
		{Role: "user", Text: "c"},
	}

	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyPgUp})
	app = next.(App)
	// ScrollOffset capped at len(Messages)*3 = 9
	if app.state.ScrollOffset != 9 {
		t.Errorf("expected scroll offset 9 (capped), got %d", app.state.ScrollOffset)
	}
}

// TestScrollDownClamp verifies Down doesn't go below 0.
func TestScrollDownClamp(t *testing.T) {
	app := New(nil)
	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyPgDown})
	app = next.(App)
	if app.state.ScrollOffset != 0 {
		t.Errorf("expected scroll offset 0, got %d", app.state.ScrollOffset)
	}
}

// TestRelayConnectedMsg sets connected state.
func TestRelayConnectedMsg(t *testing.T) {
	app := New(nil)
	next, _ := app.Update(RelayConnectedMsg{})
	app = next.(App)
	if !app.state.Connected {
		t.Error("expected Connected to be true")
	}
}

// TestRelayDisconnectedMsg clears state.
func TestRelayDisconnectedMsg(t *testing.T) {
	app := New(nil)
	app.state.Connected = true
	app.state.Active = true
	app.state.IsStreaming = true
	app.state.StreamingMessageID = "msg_1"
	app.state.ThinkingStart = mustTime(t)
	app.state.ActiveTools["tool_1"] = "bash"

	next, _ := app.Update(RelayDisconnectedMsg{Reason: "test"})
	app = next.(App)
	if app.state.Connected {
		t.Error("expected Connected false")
	}
	if app.state.Active {
		t.Error("expected Active false")
	}
	if app.state.IsStreaming {
		t.Error("expected IsStreaming false")
	}
	if app.state.StreamingMessageID != "" {
		t.Error("expected StreamingMessageID cleared")
	}
	if !app.state.ThinkingStart.IsZero() {
		t.Error("expected ThinkingStart cleared")
	}
	if len(app.state.ActiveTools) != 0 {
		t.Error("expected ActiveTools cleared")
	}
}

// TestHeartbeatMsg updates activity state.
func TestHeartbeatMsg(t *testing.T) {
	app := New(nil)
	hb := HeartbeatMsg{
		Active:       true,
		IsCompacting: true,
		SessionName:  "my-session",
		Cwd:          "/tmp/test",
	}
	hb.Model = &struct {
		Provider string `json:"provider"`
		ID       string `json:"id"`
	}{"anthropic", "claude-sonnet-4-20250514"}
	next, _ := app.Update(hb)
	app = next.(App)

	if !app.state.Active {
		t.Error("expected Active")
	}
	if !app.state.IsCompacting {
		t.Error("expected IsCompacting")
	}
	if app.state.SessionName != "my-session" {
		t.Errorf("expected 'my-session', got %q", app.state.SessionName)
	}
	if app.state.ModelID != "claude-sonnet-4-20250514" {
		t.Errorf("expected model ID, got %q", app.state.ModelID)
	}
}

// TestMessageUpdateMsg adds/updates messages.
func TestHeartbeatIdleClearsTransientState(t *testing.T) {
	app := New(nil)
	app.state.Active = true
	app.state.IsStreaming = true
	app.state.StreamingMessageID = "msg_live"
	app.state.ThinkingStart = mustTime(t)
	app.state.ActiveTools["tool_live"] = "read"

	next, _ := app.Update(HeartbeatMsg{Active: false})
	app = next.(App)

	if app.state.IsStreaming {
		t.Fatal("expected IsStreaming false")
	}
	if app.state.StreamingMessageID != "" {
		t.Fatal("expected StreamingMessageID cleared")
	}
	if !app.state.ThinkingStart.IsZero() {
		t.Fatal("expected ThinkingStart cleared")
	}
	if len(app.state.ActiveTools) != 0 {
		t.Fatal("expected ActiveTools cleared")
	}
}

func TestMessageUpdateMsg(t *testing.T) {
	app := New(nil)

	content, _ := json.Marshal([]map[string]any{
		{"type": "text", "text": "Hello there"},
	})
	var blocks []json.RawMessage
	json.Unmarshal(content, &blocks)

	next, _ := app.Update(MessageUpdateMsg{
		Role:      "assistant",
		Content:   blocks,
		MessageID: "msg_01",
	})
	app = next.(App)

	if len(app.state.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(app.state.Messages))
	}
	if app.state.Messages[0].Text != "Hello there" {
		t.Errorf("expected 'Hello there', got %q", app.state.Messages[0].Text)
	}
	// Verify streaming is cleared
	if app.state.IsStreaming {
		t.Error("expected IsStreaming false after final message_update")
	}
}

// TestToolResultMsg appends tool results.
func TestToolResultMsg(t *testing.T) {
	app := New(nil)
	next, _ := app.Update(ToolResultMsg{
		ToolName: "bash",
		Content:  "exit code 0",
		IsError:  false,
	})
	app = next.(App)

	if len(app.state.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(app.state.Messages))
	}
	if app.state.Messages[0].ToolName != "bash" {
		t.Errorf("expected tool name 'bash'")
	}
}

// TestSessionMetadataMsg updates metadata.
func TestSessionMetadataMsg(t *testing.T) {
	app := New(nil)
	sm := SessionMetadataMsg{
		CostUSD:  0.0123,
		NumTurns: 5,
	}
	sm.Model = &struct {
		Provider string `json:"provider"`
		ID       string `json:"id"`
	}{"anthropic", "claude-sonnet-4-20250514"}
	sm.Usage = &struct {
		InputTokens  int `json:"inputTokens"`
		OutputTokens int `json:"outputTokens"`
	}{1000, 500}
	next, _ := app.Update(sm)
	app = next.(App)

	if app.state.InputTokens != 1000 {
		t.Errorf("expected 1000 input tokens, got %d", app.state.InputTokens)
	}
	if app.state.NumTurns != 5 {
		t.Errorf("expected 5 turns, got %d", app.state.NumTurns)
	}
}

// TestExtractTextFromContent tests content block parsing.
func TestExtractTextFromContent(t *testing.T) {
	tests := []struct {
		name   string
		blocks string
		want   string
	}{
		{"text block", `[{"type":"text","text":"hello"}]`, "hello"},
		{"thinking block", `[{"type":"thinking","thinking":"pondering..."}]`, "[thinking] pondering..."},
		{"tool_use block", `[{"type":"tool_use","name":"bash","id":"123","input":{}}]`, "[tool: bash]"},
		{"mixed blocks", `[{"type":"text","text":"first"},{"type":"text","text":"second"}]`, "first\nsecond"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var blocks []json.RawMessage
			if err := json.Unmarshal([]byte(tt.blocks), &blocks); err != nil {
				t.Fatal(err)
			}
			got := extractTextFromContent(blocks)
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

// --- Streaming delta tests ---

func TestStreamingDeltaUpdatesExistingMessage(t *testing.T) {
	app := New(nil)
	app.state.Messages = []DisplayMessage{
		{ID: "msg_01", Role: "assistant", Text: ""},
	}

	content, _ := json.Marshal([]map[string]any{
		{"type": "text", "text": "Hello world"},
	})
	var blocks []json.RawMessage
	json.Unmarshal(content, &blocks)

	next, _ := app.Update(StreamingDeltaMsg{
		MessageID: "msg_01",
		Role:      "assistant",
		Content:   blocks,
		DeltaType: "text_delta",
	})
	app = next.(App)

	if app.state.Messages[0].Text != "Hello world" {
		t.Errorf("expected 'Hello world', got %q", app.state.Messages[0].Text)
	}
	if !app.state.IsStreaming {
		t.Error("expected IsStreaming true during streaming")
	}
}

func TestStreamingDeltaCreatesNewMessage(t *testing.T) {
	app := New(nil)

	content, _ := json.Marshal([]map[string]any{
		{"type": "text", "text": "New message"},
	})
	var blocks []json.RawMessage
	json.Unmarshal(content, &blocks)

	next, _ := app.Update(StreamingDeltaMsg{
		MessageID: "msg_02",
		Role:      "assistant",
		Content:   blocks,
		DeltaType: "text_delta",
	})
	app = next.(App)

	if len(app.state.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(app.state.Messages))
	}
	if app.state.Messages[0].ID != "msg_02" {
		t.Errorf("expected ID 'msg_02', got %q", app.state.Messages[0].ID)
	}
}

func TestThinkingDeltaRendersWithPrefix(t *testing.T) {
	app := New(nil)

	content, _ := json.Marshal([]map[string]any{
		{"type": "thinking", "thinking": "Let me consider..."},
	})
	var blocks []json.RawMessage
	json.Unmarshal(content, &blocks)

	next, _ := app.Update(StreamingDeltaMsg{
		MessageID: "msg_03",
		Role:      "assistant",
		Content:   blocks,
		DeltaType: "thinking_delta",
	})
	app = next.(App)

	if !strings.Contains(app.state.Messages[0].Text, "[thinking]") {
		t.Errorf("expected thinking prefix, got %q", app.state.Messages[0].Text)
	}
}

func TestMessageStartCreatesPlaceholder(t *testing.T) {
	app := New(nil)

	next, _ := app.Update(MessageStartMsg{MessageID: "msg_04", Role: "assistant"})
	app = next.(App)

	if len(app.state.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(app.state.Messages))
	}
	if app.state.Messages[0].ID != "msg_04" {
		t.Errorf("expected ID 'msg_04'")
	}
	if !app.state.IsStreaming {
		t.Error("expected IsStreaming true after message_start")
	}
}

func TestToolExecutionStartTracked(t *testing.T) {
	app := New(nil)
	next, _ := app.Update(ToolExecutionStartMsg{ToolCallID: "tool_abc", ToolName: "bash"})
	app = next.(App)
	if _, ok := app.state.ActiveTools["tool_abc"]; !ok {
		t.Error("expected tool_abc in ActiveTools")
	}
}

func TestToolExecutionEndClearsTracking(t *testing.T) {
	app := New(nil)
	app.state.ActiveTools["tool_abc"] = "bash"
	next, _ := app.Update(ToolExecutionEndMsg{ToolCallID: "tool_abc"})
	app = next.(App)
	if _, ok := app.state.ActiveTools["tool_abc"]; ok {
		t.Error("expected tool_abc removed")
	}
}

func TestFinalMessageUpdateClearsStreaming(t *testing.T) {
	app := New(nil)
	app.state.StreamingMessageID = "msg_01"
	app.state.IsStreaming = true
	app.state.Messages = []DisplayMessage{{ID: "msg_01", Role: "assistant", Text: "partial..."}}

	content, _ := json.Marshal([]map[string]any{
		{"type": "text", "text": "Final text"},
	})
	var blocks []json.RawMessage
	json.Unmarshal(content, &blocks)

	next, _ := app.Update(MessageUpdateMsg{MessageID: "msg_01", Role: "assistant", Content: blocks, Timestamp: 12345})
	app = next.(App)

	if app.state.IsStreaming {
		t.Error("expected IsStreaming false")
	}
	if app.state.Messages[0].Text != "Final text" {
		t.Errorf("expected final text, got %q", app.state.Messages[0].Text)
	}
}

// --- relayEventToMsg tests ---

func TestRelayEventToMsg_StreamingDelta(t *testing.T) {
	ev := map[string]any{
		"type": "message_update",
		"assistantMessageEvent": map[string]any{
			"type": "text_delta", "contentIndex": 0, "delta": "Hello",
			"partial": map[string]any{
				"id": "msg_01", "role": "assistant",
				"content": []any{map[string]any{"type": "text", "text": "Hello"}},
			},
		},
	}
	msg := relayEventToMsg(ev)
	sd, ok := msg.(StreamingDeltaMsg)
	if !ok {
		t.Fatalf("expected StreamingDeltaMsg, got %T", msg)
	}
	if sd.MessageID != "msg_01" {
		t.Errorf("expected 'msg_01', got %q", sd.MessageID)
	}
}

func TestRelayEventToMsg_MessageStart(t *testing.T) {
	ev := map[string]any{
		"type": "message_start",
		"message": map[string]any{"role": "assistant", "id": "msg_01"},
	}
	msg := relayEventToMsg(ev)
	ms, ok := msg.(MessageStartMsg)
	if !ok {
		t.Fatalf("expected MessageStartMsg, got %T", msg)
	}
	if ms.MessageID != "msg_01" {
		t.Errorf("expected 'msg_01', got %q", ms.MessageID)
	}
}

func TestRelayEventToMsg_ToolExecutionStart(t *testing.T) {
	ev := map[string]any{
		"type": "tool_execution_start", "toolCallId": "tool_xyz", "toolName": "read",
	}
	msg := relayEventToMsg(ev)
	tes, ok := msg.(ToolExecutionStartMsg)
	if !ok {
		t.Fatalf("expected ToolExecutionStartMsg, got %T", msg)
	}
	if tes.ToolCallID != "tool_xyz" {
		t.Errorf("expected 'tool_xyz', got %q", tes.ToolCallID)
	}
}

// --- Streaming lifecycle test ---

func TestStreamingLifecycle(t *testing.T) {
	app := New(nil)

	// 1. message_start
	next, _ := app.Update(MessageStartMsg{MessageID: "msg_01", Role: "assistant"})
	app = next.(App)
	if !app.state.IsStreaming {
		t.Fatal("expected streaming after message_start")
	}

	// 2. streaming deltas
	for _, text := range []string{"Hello", "Hello world"} {
		content, _ := json.Marshal([]map[string]any{{"type": "text", "text": text}})
		var blocks []json.RawMessage
		json.Unmarshal(content, &blocks)
		next, _ = app.Update(StreamingDeltaMsg{MessageID: "msg_01", Role: "assistant", Content: blocks})
		app = next.(App)
	}

	// 3. tool execution
	next, _ = app.Update(ToolExecutionStartMsg{ToolCallID: "t1", ToolName: "bash"})
	app = next.(App)
	if len(app.state.ActiveTools) != 1 {
		t.Errorf("expected 1 active tool")
	}

	next, _ = app.Update(ToolResultMsg{ToolName: "bash", Content: "ok"})
	app = next.(App)

	next, _ = app.Update(ToolExecutionEndMsg{ToolCallID: "t1"})
	app = next.(App)
	if len(app.state.ActiveTools) != 0 {
		t.Errorf("expected 0 active tools")
	}

	// 4. final message
	content, _ := json.Marshal([]map[string]any{{"type": "text", "text": "Done!"}})
	var blocks []json.RawMessage
	json.Unmarshal(content, &blocks)
	next, _ = app.Update(MessageUpdateMsg{MessageID: "msg_01", Role: "assistant", Content: blocks, Timestamp: 12345})
	app = next.(App)
	if app.state.IsStreaming {
		t.Error("expected streaming cleared")
	}
}

// --- parseRelayJSON tests ---

func TestParseRelayJSON_StreamingDelta(t *testing.T) {
	data := mustJSONBytes(t, map[string]any{
		"type": "message_update",
		"assistantMessageEvent": map[string]any{
			"type": "text_delta", "delta": "Hi",
			"partial": map[string]any{
				"id": "msg_99", "role": "assistant",
				"content": []any{map[string]any{"type": "text", "text": "Hi"}},
			},
		},
	})
	msg := parseRelayJSON(data)
	sd, ok := msg.(StreamingDeltaMsg)
	if !ok {
		t.Fatalf("expected StreamingDeltaMsg, got %T", msg)
	}
	if sd.MessageID != "msg_99" {
		t.Errorf("expected msg_99, got %q", sd.MessageID)
	}
}

func TestParseRelayJSON_ToolExecutionStart(t *testing.T) {
	data := mustJSONBytes(t, map[string]any{
		"type": "tool_execution_start", "toolCallId": "tool_01", "toolName": "edit",
	})
	msg := parseRelayJSON(data)
	tes, ok := msg.(ToolExecutionStartMsg)
	if !ok {
		t.Fatalf("expected ToolExecutionStartMsg, got %T", msg)
	}
	if tes.ToolName != "edit" {
		t.Errorf("expected 'edit', got %q", tes.ToolName)
	}
}

func TestParseRelayJSON_MessageStart(t *testing.T) {
	data := mustJSONBytes(t, map[string]any{
		"type": "message_start",
		"message": map[string]any{"id": "msg_77", "role": "assistant"},
	})
	msg := parseRelayJSON(data)
	ms, ok := msg.(MessageStartMsg)
	if !ok {
		t.Fatalf("expected MessageStartMsg, got %T", msg)
	}
	if ms.MessageID != "msg_77" {
		t.Errorf("expected msg_77, got %q", ms.MessageID)
	}
}

// --- Format tokens test ---

func TestFormatTokens(t *testing.T) {
	tests := []struct {
		input int
		want  string
	}{
		{0, "0"},
		{500, "500"},
		{1500, "1.5k"},
		{12345, "12k"},
		{1234567, "1.2M"},
	}
	for _, tt := range tests {
		got := formatTokens(tt.input)
		if got != tt.want {
			t.Errorf("formatTokens(%d) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

// TestViewNarrowTerminal verifies the view doesn't panic at narrow widths.
func TestViewNarrowTerminal(t *testing.T) {
	app := New(nil)
	app.state.Messages = []DisplayMessage{
		{Role: "user", Text: "hello"},
		{Role: "assistant", Text: "world"},
		{Role: "tool_result", Text: "output text here", ToolName: "bash"},
	}
	app.state.Connected = true
	app.state.ModelID = "gpt-5.4-codex-with-a-very-long-name"
	app.state.Cwd = "/very/long/path/to/some/deeply/nested/directory"

	// Test various narrow widths
	for _, w := range []int{30, 40, 50, 60, 80, 120} {
		next, _ := app.Update(tea.WindowSizeMsg{Width: w, Height: 20})
		app = next.(App)
		out := app.View()
		if strings.TrimSpace(out) == "" {
			t.Errorf("empty view at width %d", w)
		}
	}
}

// TestViewVeryShortTerminal verifies the view works with minimal height.
func TestViewVeryShortTerminal(t *testing.T) {
	app := New(nil)
	app.state.Messages = []DisplayMessage{{Role: "user", Text: "hi"}}

	for _, h := range []int{5, 6, 8, 10} {
		next, _ := app.Update(tea.WindowSizeMsg{Width: 80, Height: h})
		app = next.(App)
		out := app.View()
		if strings.TrimSpace(out) == "" {
			t.Errorf("empty view at height %d", h)
		}
	}
}

// --- Message ordering tests ---

// TestMessageEndUpsertsById verifies that message_end with "id" field
// correctly upserts the existing streaming message (Bug 5 regression test).
func TestMessageEndUpsertsById(t *testing.T) {
	app := New(nil)

	// Simulate: message_start creates placeholder
	next, _ := app.Update(MessageStartMsg{MessageID: "msg_01", Role: "assistant"})
	app = next.(App)
	if len(app.state.Messages) != 1 {
		t.Fatalf("expected 1 message after start, got %d", len(app.state.Messages))
	}

	// Simulate: streaming delta fills in text
	content, _ := json.Marshal([]map[string]any{{"type": "text", "text": "Hello"}})
	var blocks []json.RawMessage
	json.Unmarshal(content, &blocks)
	next, _ = app.Update(StreamingDeltaMsg{MessageID: "msg_01", Role: "assistant", Content: blocks})
	app = next.(App)
	if len(app.state.Messages) != 1 {
		t.Fatalf("expected 1 message after delta, got %d", len(app.state.Messages))
	}

	// Simulate: message_end from relayEventToMsg (adapter uses "id" not "messageId")
	// This is the actual relay event shape from the Claude adapter.
	endEvent := map[string]any{
		"type": "message_end",
		"message": map[string]any{
			"role":      "assistant",
			"id":        "msg_01", // NOTE: "id" not "messageId"
			"content":   []any{map[string]any{"type": "text", "text": "Hello world"}},
			"timestamp": float64(12345),
		},
	}
	endMsg := relayEventToMsg(endEvent)
	mu, ok := endMsg.(MessageUpdateMsg)
	if !ok {
		t.Fatalf("expected MessageUpdateMsg from message_end, got %T", endMsg)
	}
	// KEY ASSERTION: MessageID must be populated from "id" field
	if mu.MessageID != "msg_01" {
		t.Fatalf("Bug 5: message_end MessageID empty — 'id' field not extracted. Got %q", mu.MessageID)
	}

	next, _ = app.Update(mu)
	app = next.(App)

	// Must still be 1 message (upsert, not append)
	if len(app.state.Messages) != 1 {
		t.Fatalf("Bug 5: message_end created duplicate — expected 1 message, got %d", len(app.state.Messages))
	}
	if app.state.Messages[0].Text != "Hello world" {
		t.Errorf("expected final text 'Hello world', got %q", app.state.Messages[0].Text)
	}
}

// TestFinalMessageUpdateById verifies message_update with "id" field upserts.
func TestFinalMessageUpdateById(t *testing.T) {
	app := New(nil)
	app.state.Messages = []DisplayMessage{{ID: "msg_01", Role: "assistant", Text: "partial"}}

	event := map[string]any{
		"type": "message_update",
		"message": map[string]any{
			"role":    "assistant",
			"id":      "msg_01",
			"content": []any{map[string]any{"type": "text", "text": "complete"}},
		},
	}
	msg := relayEventToMsg(event)
	mu, ok := msg.(MessageUpdateMsg)
	if !ok {
		t.Fatalf("expected MessageUpdateMsg, got %T", msg)
	}
	if mu.MessageID != "msg_01" {
		t.Fatalf("MessageID not extracted from 'id' field: got %q", mu.MessageID)
	}

	next, _ := app.Update(mu)
	app = next.(App)

	if len(app.state.Messages) != 1 {
		t.Fatalf("expected 1 message (upsert), got %d", len(app.state.Messages))
	}
}

// TestSessionActivePreservesLocalUserMessage verifies that session_active
// doesn't wipe locally-added user messages (Bug 1 regression test).
func TestSessionActivePreservesLocalUserMessage(t *testing.T) {
	app := New(nil)

	// User types a message locally (no ID — locally added)
	app.state.Messages = []DisplayMessage{
		{Role: "user", Text: "hello from user"},
	}

	// session_active arrives with only system messages (adapter hasn't seen user msg yet)
	stateJSON, _ := json.Marshal([]map[string]any{
		{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "Hi"}}, "messageId": "msg_01"},
	})
	var rawMsgs []json.RawMessage
	json.Unmarshal(stateJSON, &rawMsgs)

	sa := SessionActiveMsg{}
	sa.State.Messages = rawMsgs

	next, _ := app.Update(sa)
	app = next.(App)

	// Should have both: the assistant message from snapshot + the local user message
	hasUser := false
	hasAssistant := false
	for _, m := range app.state.Messages {
		if m.Role == "user" && m.Text == "hello from user" {
			hasUser = true
		}
		if m.Role == "assistant" {
			hasAssistant = true
		}
	}
	if !hasUser {
		t.Error("Bug 1: session_active wiped the locally-added user message")
	}
	if !hasAssistant {
		t.Error("expected assistant message from snapshot")
	}
}

// TestStreamingDeltaEmptyIdGetsFallback verifies that streaming deltas
// with empty ID get a fallback (Bug 3 regression test).
func TestStreamingDeltaEmptyIdGetsFallback(t *testing.T) {
	// Simulate an assistantMessageEvent with no id in partial
	event := map[string]any{
		"type": "message_update",
		"assistantMessageEvent": map[string]any{
			"type":  "text_delta",
			"delta": "Hello",
			"partial": map[string]any{
				"role":    "assistant",
				"content": []any{map[string]any{"type": "text", "text": "Hello"}},
				// NOTE: no "id" field
			},
		},
	}
	msg := relayEventToMsg(event)
	sd, ok := msg.(StreamingDeltaMsg)
	if !ok {
		t.Fatalf("expected StreamingDeltaMsg, got %T", msg)
	}
	if sd.MessageID == "" {
		t.Fatal("Bug 3: empty MessageID not given fallback")
	}
	if sd.MessageID != "streaming_partial" {
		t.Errorf("expected fallback 'streaming_partial', got %q", sd.MessageID)
	}
}

// TestFullConversationOrdering simulates a realistic multi-turn conversation
// and verifies the final message order is correct.
func TestFullConversationOrdering(t *testing.T) {
	app := New(nil)

	// 1. User sends a message
	app.state.Input.SetValue("explain main.go")
	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyEnter})
	app = next.(App)
	// Messages: [user:"explain main.go"]

	// 2. message_start
	next, _ = app.Update(MessageStartMsg{MessageID: "msg_01", Role: "assistant"})
	app = next.(App)
	// Messages: [user, assistant:""]

	// 3. Streaming deltas
	for _, text := range []string{"This", "This file", "This file contains"} {
		content, _ := json.Marshal([]map[string]any{{"type": "text", "text": text}})
		var blocks []json.RawMessage
		json.Unmarshal(content, &blocks)
		next, _ = app.Update(StreamingDeltaMsg{MessageID: "msg_01", Role: "assistant", Content: blocks})
		app = next.(App)
	}
	// Messages: [user, assistant:"This file contains"]

	// 4. Tool execution
	next, _ = app.Update(ToolExecutionStartMsg{ToolCallID: "t1", ToolName: "read"})
	app = next.(App)

	next, _ = app.Update(ToolResultMsg{ToolName: "read", Content: "package main...", Timestamp: 1000})
	app = next.(App)
	// Messages: [user, assistant:"This file contains", tool_result:"package main..."]

	next, _ = app.Update(ToolExecutionEndMsg{ToolCallID: "t1"})
	app = next.(App)

	// 5. More streaming
	content2, _ := json.Marshal([]map[string]any{{"type": "text", "text": "After reading the file, I can see..."}})
	var blocks2 []json.RawMessage
	json.Unmarshal(content2, &blocks2)
	next, _ = app.Update(StreamingDeltaMsg{MessageID: "msg_02", Role: "assistant", Content: blocks2})
	app = next.(App)

	// 6. Final message
	content3, _ := json.Marshal([]map[string]any{{"type": "text", "text": "After reading the file, I can see it's a Go entry point."}})
	var blocks3 []json.RawMessage
	json.Unmarshal(content3, &blocks3)
	next, _ = app.Update(MessageUpdateMsg{MessageID: "msg_02", Role: "assistant", Content: blocks3, Timestamp: 2000})
	app = next.(App)

	// Verify order
	if len(app.state.Messages) < 4 {
		t.Fatalf("expected at least 4 messages, got %d", len(app.state.Messages))
	}

	// Check roles in order
	expected := []string{"user", "assistant", "tool_result", "assistant"}
	for i, exp := range expected {
		if i >= len(app.state.Messages) {
			break
		}
		if app.state.Messages[i].Role != exp {
			t.Errorf("message[%d]: expected role %q, got %q", i, exp, app.state.Messages[i].Role)
		}
	}

	// Verify no duplicates — msg_01 should appear exactly once
	count01 := 0
	for _, m := range app.state.Messages {
		if m.ID == "msg_01" {
			count01++
		}
	}
	if count01 != 1 {
		t.Errorf("expected msg_01 exactly once, found %d times", count01)
	}

	// Streaming should be cleared
	if app.state.IsStreaming {
		t.Error("expected IsStreaming false after final message")
	}
}

// TestParseRelayJSON_MessageEndExtractsId verifies the relay JSON parser
// correctly extracts "id" from message_end events.
func TestParseRelayJSON_MessageEndExtractsId(t *testing.T) {
	data := mustJSONBytes(t, map[string]any{
		"type": "message_end",
		"message": map[string]any{
			"role":      "assistant",
			"id":        "msg_42",
			"content":   []any{map[string]any{"type": "text", "text": "done"}},
			"timestamp": float64(99999),
		},
	})

	msg := parseRelayJSON(data)
	mu, ok := msg.(MessageUpdateMsg)
	if !ok {
		t.Fatalf("expected MessageUpdateMsg, got %T", msg)
	}
	if mu.MessageID != "msg_42" {
		t.Errorf("expected MessageID 'msg_42', got %q", mu.MessageID)
	}
}

// TestParseRelayJSON_MessageUpdateExtractsId verifies final message_update
// extracts "id" from the nested message object.
func TestParseRelayJSON_MessageUpdateExtractsId(t *testing.T) {
	data := mustJSONBytes(t, map[string]any{
		"type": "message_update",
		"message": map[string]any{
			"role":    "assistant",
			"id":      "msg_77",
			"content": []any{map[string]any{"type": "text", "text": "hi"}},
		},
	})

	msg := parseRelayJSON(data)
	mu, ok := msg.(MessageUpdateMsg)
	if !ok {
		t.Fatalf("expected MessageUpdateMsg, got %T", msg)
	}
	if mu.MessageID != "msg_77" {
		t.Errorf("expected MessageID 'msg_77', got %q", mu.MessageID)
	}
	if mu.Role != "assistant" {
		t.Errorf("expected role assistant, got %q", mu.Role)
	}
	if got := extractTextFromContent(mu.Content); got != "hi" {
		t.Errorf("expected content 'hi', got %q", got)
	}
}

func TestParseMessagesSupportsIDAndToolResultString(t *testing.T) {
	raw := []json.RawMessage{
		mustJSONBytes(t, map[string]any{
			"role":    "assistant",
			"id":      "msg_from_id",
			"content": []any{map[string]any{"type": "text", "text": "hello"}},
		}),
		mustJSONBytes(t, map[string]any{
			"role":      "tool_result",
			"toolName":  "bash",
			"content":   "plain output",
			"timestamp": 123,
		}),
	}
	msgs := parseMessages(raw)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 parsed messages, got %d", len(msgs))
	}
	if msgs[0].ID != "msg_from_id" {
		t.Fatalf("expected assistant ID from id field, got %q", msgs[0].ID)
	}
	if msgs[1].Text != "plain output" {
		t.Fatalf("expected unquoted tool result text, got %q", msgs[1].Text)
	}
}

func TestSessionActiveReconcilesOptimisticUserMessage(t *testing.T) {
	app := New(nil)
	app.state.Messages = []DisplayMessage{{Role: "user", Text: "same prompt"}}

	sa := SessionActiveMsg{}
	sa.State.Messages = []json.RawMessage{
		mustJSONBytes(t, map[string]any{
			"role":      "user",
			"messageId": "user_01",
			"content":   []any{map[string]any{"type": "text", "text": "same prompt"}},
		}),
	}

	next, _ := app.Update(sa)
	app = next.(App)
	if len(app.state.Messages) != 1 {
		t.Fatalf("expected optimistic user message to reconcile to 1 entry, got %d", len(app.state.Messages))
	}
	if app.state.Messages[0].ID != "user_01" {
		t.Fatalf("expected reconciled server ID user_01, got %q", app.state.Messages[0].ID)
	}
}

func TestToolUseUpdateDoesNotClobberExistingAssistantText(t *testing.T) {
	app := New(nil)
	app.state.Messages = []DisplayMessage{{ID: "msg_01", Role: "assistant", Text: "I will inspect the file"}}

	content := []json.RawMessage{mustJSONBytes(t, map[string]any{
		"type":  "tool_use",
		"id":    "tool_1",
		"name":  "read",
		"input": map[string]any{"path": "main.go"},
	})}
	msg := MessageUpdateMsg{MessageID: "msg_01", Role: "assistant", Content: content}

	next, _ := app.Update(msg)
	app = next.(App)
	if got := app.state.Messages[0].Text; got != "I will inspect the file" {
		t.Fatalf("tool-only update clobbered streamed text: %q", got)
	}
}

func TestRelayFinalMessageUpdateEndToEnd_NoDuplicateAndContentParsed(t *testing.T) {
	app := New(nil)
	next, _ := app.Update(MessageStartMsg{MessageID: "msg_90", Role: "assistant"})
	app = next.(App)

	stream := mustJSONBytes(t, map[string]any{
		"type": "message_update",
		"assistantMessageEvent": map[string]any{
			"type":  "text_delta",
			"delta": "hel",
			"partial": map[string]any{
				"id":      "msg_90",
				"role":    "assistant",
				"content": []any{map[string]any{"type": "text", "text": "hel"}},
			},
		},
	})
	msg1 := parseRelayJSON(stream)
	next, _ = app.Update(msg1)
	app = next.(App)

	final := mustJSONBytes(t, map[string]any{
		"type": "message_update",
		"message": map[string]any{
			"id":      "msg_90",
			"role":    "assistant",
			"content": []any{map[string]any{"type": "text", "text": "hello"}},
		},
	})
	msg2 := parseRelayJSON(final)
	next, _ = app.Update(msg2)
	app = next.(App)

	if len(app.state.Messages) != 1 {
		t.Fatalf("expected one upserted message, got %d", len(app.state.Messages))
	}
	if app.state.Messages[0].Text != "hello" {
		t.Fatalf("expected final parsed content hello, got %q", app.state.Messages[0].Text)
	}
}

func TestReconnectResumeFromSnapshotClearsTransientStateAndPreservesSnapshot(t *testing.T) {
	app := New(nil)

	// Simulate mid-stream disconnect with stale transient state.
	app.state.Messages = []DisplayMessage{
		{Role: "user", Text: "prompt"},
		{ID: "msg_live", Role: "assistant", Text: "partial"},
	}
	app.state.Active = true
	app.state.IsStreaming = true
	app.state.StreamingMessageID = "msg_live"
	app.state.ThinkingStart = mustTime(t)
	app.state.ActiveTools["tool_1"] = "read"

	next, _ := app.Update(RelayDisconnectedMsg{Reason: "network blip"})
	app = next.(App)

	// Reconnect and receive a fresh snapshot + idle heartbeat.
	sa := SessionActiveMsg{}
	sa.State.Cwd = "/repo"
	sa.State.Messages = []json.RawMessage{
		mustJSONBytes(t, map[string]any{
			"role":      "user",
			"messageId": "user_01",
			"content":   []any{map[string]any{"type": "text", "text": "prompt"}},
		}),
		mustJSONBytes(t, map[string]any{
			"role":    "assistant",
			"id":      "msg_live",
			"content": []any{map[string]any{"type": "text", "text": "complete"}},
		}),
	}
	next, _ = app.Update(sa)
	app = next.(App)
	next, _ = app.Update(HeartbeatMsg{Active: false, Cwd: "/repo"})
	app = next.(App)

	if len(app.state.Messages) != 2 {
		t.Fatalf("expected 2 snapshot messages after resume, got %d", len(app.state.Messages))
	}
	if app.state.Messages[1].Text != "complete" {
		t.Fatalf("expected resumed assistant text 'complete', got %q", app.state.Messages[1].Text)
	}
	if len(app.state.ActiveTools) != 0 {
		t.Fatal("expected stale tools cleared after reconnect resume")
	}
	if app.state.IsStreaming {
		t.Fatal("expected streaming false after resume heartbeat")
	}
}

func TestHighVolumeStreamingDeltasSingleMessageNoDupes(t *testing.T) {
	app := New(nil)
	next, _ := app.Update(MessageStartMsg{MessageID: "msg_stress", Role: "assistant"})
	app = next.(App)

	finalText := ""
	for i := 0; i < 250; i++ {
		finalText += fmt.Sprintf("chunk-%03d ", i)
		payload := mustJSONBytes(t, map[string]any{
			"type": "message_update",
			"assistantMessageEvent": map[string]any{
				"type":  "text_delta",
				"delta": fmt.Sprintf("chunk-%03d ", i),
				"partial": map[string]any{
					"id":      "msg_stress",
					"role":    "assistant",
					"content": []any{map[string]any{"type": "text", "text": finalText}},
				},
			},
		})
		msg := parseRelayJSON(payload)
		next, _ = app.Update(msg)
		app = next.(App)
	}

	final := mustJSONBytes(t, map[string]any{
		"type": "message_end",
		"message": map[string]any{
			"id":      "msg_stress",
			"role":    "assistant",
			"content": []any{map[string]any{"type": "text", "text": finalText}},
		},
	})
	msg := parseRelayJSON(final)
	next, _ = app.Update(msg)
	app = next.(App)

	if len(app.state.Messages) != 1 {
		t.Fatalf("expected one stress-streamed message, got %d", len(app.state.Messages))
	}
	if app.state.Messages[0].Text != finalText {
		t.Fatalf("final streamed text mismatch: got len=%d want len=%d", len(app.state.Messages[0].Text), len(finalText))
	}
	if app.state.IsStreaming {
		t.Fatal("expected streaming cleared after final message")
	}
}

func TestHighVolumeInterleavedStreamingAndToolsOrdering(t *testing.T) {
	app := New(nil)
	next, _ := app.Update(MessageStartMsg{MessageID: "msg_mix", Role: "assistant"})
	app = next.(App)

	for i := 0; i < 40; i++ {
		text := fmt.Sprintf("step-%02d", i)
		blocks := []json.RawMessage{mustJSONBytes(t, map[string]any{"type": "text", "text": text})}
		next, _ = app.Update(StreamingDeltaMsg{MessageID: "msg_mix", Role: "assistant", Content: blocks, DeltaType: "text_delta"})
		app = next.(App)

		toolID := fmt.Sprintf("tool_%02d", i)
		next, _ = app.Update(ToolExecutionStartMsg{ToolCallID: toolID, ToolName: "read"})
		app = next.(App)
		next, _ = app.Update(ToolResultMsg{ToolCallID: toolID, ToolName: "read", Content: fmt.Sprintf("result-%02d", i), Timestamp: int64(i + 1)})
		app = next.(App)
		next, _ = app.Update(ToolExecutionEndMsg{ToolCallID: toolID, ToolName: "read"})
		app = next.(App)
	}

	finalBlocks := []json.RawMessage{mustJSONBytes(t, map[string]any{"type": "text", "text": "done"})}
	next, _ = app.Update(MessageUpdateMsg{MessageID: "msg_mix", Role: "assistant", Content: finalBlocks, Timestamp: 999})
	app = next.(App)

	if got := app.state.Messages[0].ID; got != "msg_mix" {
		t.Fatalf("expected assistant placeholder first, got %q", got)
	}
	toolCount := 0
	for _, m := range app.state.Messages {
		if m.Role == "tool_result" {
			toolCount++
		}
	}
	if toolCount != 40 {
		t.Fatalf("expected 40 tool results, got %d", toolCount)
	}
	if len(app.state.ActiveTools) != 0 {
		t.Fatal("expected no active tools after all end events")
	}
	if app.state.Messages[0].Text != "done" {
		t.Fatalf("expected assistant message finalized to done, got %q", app.state.Messages[0].Text)
	}
}

func mustJSONBytes(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func mustTime(t *testing.T) time.Time {
	t.Helper()
	return time.Unix(123, 0)
}
