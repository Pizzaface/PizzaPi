package tui

import (
	"encoding/json"
	"strings"
	"testing"

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

func mustJSONBytes(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
