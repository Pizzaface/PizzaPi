package tui

import (
	"encoding/json"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// TestModelDefaults verifies that a new App initialises with correct defaults.
func TestModelDefaults(t *testing.T) {
	app := New(nil) // no session controller
	s := app.state

	if len(s.Sessions) != 0 {
		t.Errorf("expected empty session list, got %d", len(s.Sessions))
	}
	if len(s.Messages) != 0 {
		t.Errorf("expected empty message buffer, got %d", len(s.Messages))
	}
	if s.ScrollOffset != 0 {
		t.Errorf("expected scroll offset 0, got %d", s.ScrollOffset)
	}
	if s.ActivePanel != PanelMain {
		t.Errorf("expected PanelMain as default, got %v", s.ActivePanel)
	}
	if s.Components == nil {
		t.Error("expected non-nil component registry")
	}
}

// TestQuitKeyFromSidebar verifies that 'q' quits when sidebar is focused.
func TestQuitKeyFromSidebar(t *testing.T) {
	app := New(nil)
	// Switch to sidebar first
	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyTab})
	app = next.(App)
	if app.state.ActivePanel != PanelSidebar {
		t.Fatalf("expected PanelSidebar after Tab, got %v", app.state.ActivePanel)
	}

	_, cmd := app.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("q")})
	if cmd == nil {
		t.Fatal("expected a command, got nil")
	}
	msg := cmd()
	if _, ok := msg.(tea.QuitMsg); !ok {
		t.Errorf("expected tea.QuitMsg, got %T", msg)
	}
}

// TestQKeyInMainPanelDoesNotQuit verifies 'q' in main panel goes to input.
func TestQKeyInMainPanelDoesNotQuit(t *testing.T) {
	app := New(nil)
	if app.state.ActivePanel != PanelMain {
		t.Fatalf("expected PanelMain initially, got %v", app.state.ActivePanel)
	}

	_, cmd := app.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("q")})
	if cmd != nil {
		msg := cmd()
		if _, isQuit := msg.(tea.QuitMsg); isQuit {
			t.Error("pressing 'q' in PanelMain must not quit")
		}
	}
}

// TestCtrlCQuit verifies ctrl+c quits from any panel.
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

// TestTabTogglesPanel verifies Tab switches between panels.
func TestTabTogglesPanel(t *testing.T) {
	app := New(nil)
	if app.state.ActivePanel != PanelMain {
		t.Fatalf("expected PanelMain initially")
	}

	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyTab})
	app = next.(App)
	if app.state.ActivePanel != PanelSidebar {
		t.Errorf("expected PanelSidebar after Tab")
	}

	next, _ = app.Update(tea.KeyMsg{Type: tea.KeyTab})
	app = next.(App)
	if app.state.ActivePanel != PanelMain {
		t.Errorf("expected PanelMain after second Tab")
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
	if app.state.Input.Value() != "" {
		t.Errorf("expected empty input after Enter")
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

// TestScrollUp verifies Up increments scroll offset.
func TestScrollUp(t *testing.T) {
	app := New(nil)
	app.state.Messages = []DisplayMessage{
		{Role: "user", Text: "a"},
		{Role: "user", Text: "b"},
		{Role: "user", Text: "c"},
	}

	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyUp})
	app = next.(App)
	if app.state.ScrollOffset != 1 {
		t.Errorf("expected scroll offset 1, got %d", app.state.ScrollOffset)
	}
}

// TestScrollDownClamp verifies Down doesn't go below 0.
func TestScrollDownClamp(t *testing.T) {
	app := New(nil)
	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyDown})
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

	next, _ := app.Update(RelayDisconnectedMsg{Reason: "test"})
	app = next.(App)
	if app.state.Connected {
		t.Error("expected Connected to be false")
	}
	if app.state.Active {
		t.Error("expected Active to be false")
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
		t.Errorf("expected session name 'my-session', got %q", app.state.SessionName)
	}
	if app.state.ModelID != "claude-sonnet-4-20250514" {
		t.Errorf("expected model ID, got %q", app.state.ModelID)
	}
}

// TestMessageUpdateMsg adds/updates messages.
func TestMessageUpdateMsg(t *testing.T) {
	app := New(nil)

	// First message
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
	if app.state.Messages[0].ID != "msg_01" {
		t.Errorf("expected ID 'msg_01', got %q", app.state.Messages[0].ID)
	}

	// Update existing message (streaming)
	content2, _ := json.Marshal([]map[string]any{
		{"type": "text", "text": "Hello there, how are you?"},
	})
	var blocks2 []json.RawMessage
	json.Unmarshal(content2, &blocks2)

	next, _ = app.Update(MessageUpdateMsg{
		Role:      "assistant",
		Content:   blocks2,
		MessageID: "msg_01",
	})
	app = next.(App)

	if len(app.state.Messages) != 1 {
		t.Fatalf("expected still 1 message, got %d", len(app.state.Messages))
	}
	if app.state.Messages[0].Text != "Hello there, how are you?" {
		t.Errorf("expected updated text, got %q", app.state.Messages[0].Text)
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
	if app.state.Messages[0].Role != "tool_result" {
		t.Errorf("expected role 'tool_result'")
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
	if app.state.OutputTokens != 500 {
		t.Errorf("expected 500 output tokens, got %d", app.state.OutputTokens)
	}
	if app.state.NumTurns != 5 {
		t.Errorf("expected 5 turns, got %d", app.state.NumTurns)
	}
}

// TestComponentRegistry tests the extension component system.
func TestComponentRegistry(t *testing.T) {
	reg := NewComponentRegistry()

	if reg.Len() != 0 {
		t.Errorf("expected empty registry, got %d", reg.Len())
	}

	c := &mockComponent{name: "test-panel"}
	reg.Register(c)

	if reg.Len() != 1 {
		t.Errorf("expected 1 component, got %d", reg.Len())
	}
	if reg.Get("test-panel") == nil {
		t.Error("expected to find 'test-panel'")
	}
	if reg.Get("nonexistent") != nil {
		t.Error("expected nil for nonexistent component")
	}

	// Replace existing
	c2 := &mockComponent{name: "test-panel", viewText: "replaced"}
	reg.Register(c2)
	if reg.Len() != 1 {
		t.Errorf("expected still 1 component after replace, got %d", reg.Len())
	}
}

// TestWithComponent verifies fluent component registration.
func TestWithComponent(t *testing.T) {
	app := New(nil).
		WithComponent(&mockComponent{name: "panel-a"}).
		WithComponent(&mockComponent{name: "panel-b"})

	if app.state.Components.Len() != 2 {
		t.Errorf("expected 2 components, got %d", app.state.Components.Len())
	}
}

// TestExtractTextFromContent tests content block parsing.
func TestExtractTextFromContent(t *testing.T) {
	tests := []struct {
		name   string
		blocks string
		want   string
	}{
		{
			name:   "text block",
			blocks: `[{"type":"text","text":"hello"}]`,
			want:   "hello",
		},
		{
			name:   "thinking block",
			blocks: `[{"type":"thinking","thinking":"pondering..."}]`,
			want:   "[thinking] pondering...",
		},
		{
			name:   "tool_use block",
			blocks: `[{"type":"tool_use","name":"bash","id":"123","input":{}}]`,
			want:   "[tool: bash]",
		},
		{
			name:   "mixed blocks",
			blocks: `[{"type":"text","text":"first"},{"type":"text","text":"second"}]`,
			want:   "first\nsecond",
		},
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
	// Pre-populate a message (as if message_start created it)
	app.state.Messages = []DisplayMessage{
		{ID: "msg_01", Role: "assistant", Text: "▍"},
	}

	// Send a streaming delta with accumulated content
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
		Delta:     "Hello world",
	})
	app = next.(App)

	if len(app.state.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(app.state.Messages))
	}
	if app.state.Messages[0].Text != "Hello world" {
		t.Errorf("expected 'Hello world', got %q", app.state.Messages[0].Text)
	}
	if app.state.StreamingMessageID != "msg_01" {
		t.Errorf("expected StreamingMessageID 'msg_01', got %q", app.state.StreamingMessageID)
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
		Delta:     "New message",
	})
	app = next.(App)

	if len(app.state.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(app.state.Messages))
	}
	if app.state.Messages[0].ID != "msg_02" {
		t.Errorf("expected ID 'msg_02', got %q", app.state.Messages[0].ID)
	}
	if app.state.Messages[0].Text != "New message" {
		t.Errorf("expected 'New message', got %q", app.state.Messages[0].Text)
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
		Delta:     "Let me consider...",
	})
	app = next.(App)

	if len(app.state.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(app.state.Messages))
	}
	if !strings.Contains(app.state.Messages[0].Text, "[thinking]") {
		t.Errorf("expected thinking prefix, got %q", app.state.Messages[0].Text)
	}
	if !strings.Contains(app.state.Messages[0].Text, "Let me consider...") {
		t.Errorf("expected thinking content, got %q", app.state.Messages[0].Text)
	}
}

func TestMessageStartCreatesPlaceholder(t *testing.T) {
	app := New(nil)

	next, _ := app.Update(MessageStartMsg{
		MessageID: "msg_04",
		Role:      "assistant",
	})
	app = next.(App)

	if len(app.state.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(app.state.Messages))
	}
	if app.state.Messages[0].ID != "msg_04" {
		t.Errorf("expected ID 'msg_04', got %q", app.state.Messages[0].ID)
	}
	if app.state.Messages[0].Role != "assistant" {
		t.Errorf("expected role 'assistant', got %q", app.state.Messages[0].Role)
	}
	if app.state.Messages[0].Text != "▍" {
		t.Errorf("expected cursor placeholder, got %q", app.state.Messages[0].Text)
	}
	if app.state.StreamingMessageID != "msg_04" {
		t.Errorf("expected StreamingMessageID set")
	}
}

func TestMessageStartDoesNotDuplicate(t *testing.T) {
	app := New(nil)
	// Pre-populate
	app.state.Messages = []DisplayMessage{
		{ID: "msg_04", Role: "assistant", Text: "existing"},
	}

	next, _ := app.Update(MessageStartMsg{
		MessageID: "msg_04",
		Role:      "assistant",
	})
	app = next.(App)

	if len(app.state.Messages) != 1 {
		t.Fatalf("expected 1 message (no duplicate), got %d", len(app.state.Messages))
	}
	// Should not overwrite existing text
	if app.state.Messages[0].Text != "existing" {
		t.Errorf("existing message should not be overwritten, got %q", app.state.Messages[0].Text)
	}
}

func TestToolExecutionStartTracked(t *testing.T) {
	app := New(nil)

	next, _ := app.Update(ToolExecutionStartMsg{
		ToolCallID: "tool_abc",
		ToolName:   "bash",
	})
	app = next.(App)

	if name, ok := app.state.ActiveTools["tool_abc"]; !ok {
		t.Error("expected tool_abc in ActiveTools")
	} else if name != "bash" {
		t.Errorf("expected tool name 'bash', got %q", name)
	}
}

func TestToolExecutionEndClearsTracking(t *testing.T) {
	app := New(nil)
	app.state.ActiveTools["tool_abc"] = "bash"

	next, _ := app.Update(ToolExecutionEndMsg{
		ToolCallID: "tool_abc",
		ToolName:   "bash",
		IsError:    false,
	})
	app = next.(App)

	if _, ok := app.state.ActiveTools["tool_abc"]; ok {
		t.Error("expected tool_abc removed from ActiveTools")
	}
}

func TestFinalMessageUpdateClearsStreaming(t *testing.T) {
	app := New(nil)
	app.state.StreamingMessageID = "msg_01"
	app.state.Messages = []DisplayMessage{
		{ID: "msg_01", Role: "assistant", Text: "partial..."},
	}

	content, _ := json.Marshal([]map[string]any{
		{"type": "text", "text": "Final complete text"},
	})
	var blocks []json.RawMessage
	json.Unmarshal(content, &blocks)

	next, _ := app.Update(MessageUpdateMsg{
		MessageID: "msg_01",
		Role:      "assistant",
		Content:   blocks,
		Timestamp: 12345,
	})
	app = next.(App)

	if app.state.StreamingMessageID != "" {
		t.Errorf("expected StreamingMessageID cleared, got %q", app.state.StreamingMessageID)
	}
	if app.state.Messages[0].Text != "Final complete text" {
		t.Errorf("expected final text, got %q", app.state.Messages[0].Text)
	}
	if app.state.Messages[0].Timestamp != 12345 {
		t.Errorf("expected timestamp 12345, got %d", app.state.Messages[0].Timestamp)
	}
}

// --- relayEventToMsg tests ---

func TestRelayEventToMsg_StreamingDelta(t *testing.T) {
	ev := map[string]any{
		"type": "message_update",
		"assistantMessageEvent": map[string]any{
			"type":         "text_delta",
			"contentIndex": 0,
			"delta":        "Hello",
			"partial": map[string]any{
				"id":   "msg_01",
				"role": "assistant",
				"content": []any{
					map[string]any{"type": "text", "text": "Hello"},
				},
			},
		},
	}

	msg := relayEventToMsg(ev)
	sd, ok := msg.(StreamingDeltaMsg)
	if !ok {
		t.Fatalf("expected StreamingDeltaMsg, got %T", msg)
	}
	if sd.MessageID != "msg_01" {
		t.Errorf("expected message ID 'msg_01', got %q", sd.MessageID)
	}
	if sd.DeltaType != "text_delta" {
		t.Errorf("expected delta type 'text_delta', got %q", sd.DeltaType)
	}
	if sd.Delta != "Hello" {
		t.Errorf("expected delta 'Hello', got %q", sd.Delta)
	}
	if len(sd.Content) != 1 {
		t.Fatalf("expected 1 content block, got %d", len(sd.Content))
	}
}

func TestRelayEventToMsg_MessageStart(t *testing.T) {
	ev := map[string]any{
		"type": "message_start",
		"message": map[string]any{
			"role": "assistant",
			"id":   "msg_01",
		},
	}

	msg := relayEventToMsg(ev)
	ms, ok := msg.(MessageStartMsg)
	if !ok {
		t.Fatalf("expected MessageStartMsg, got %T", msg)
	}
	if ms.MessageID != "msg_01" {
		t.Errorf("expected ID 'msg_01', got %q", ms.MessageID)
	}
	if ms.Role != "assistant" {
		t.Errorf("expected role 'assistant', got %q", ms.Role)
	}
}

func TestRelayEventToMsg_ToolExecutionStart(t *testing.T) {
	ev := map[string]any{
		"type":       "tool_execution_start",
		"toolCallId": "tool_xyz",
		"toolName":   "read",
	}

	msg := relayEventToMsg(ev)
	tes, ok := msg.(ToolExecutionStartMsg)
	if !ok {
		t.Fatalf("expected ToolExecutionStartMsg, got %T", msg)
	}
	if tes.ToolCallID != "tool_xyz" {
		t.Errorf("expected toolCallId 'tool_xyz', got %q", tes.ToolCallID)
	}
	if tes.ToolName != "read" {
		t.Errorf("expected toolName 'read', got %q", tes.ToolName)
	}
}

func TestRelayEventToMsg_ToolExecutionEnd(t *testing.T) {
	ev := map[string]any{
		"type":       "tool_execution_end",
		"toolCallId": "tool_xyz",
		"toolName":   "read",
		"isError":    true,
	}

	msg := relayEventToMsg(ev)
	tee, ok := msg.(ToolExecutionEndMsg)
	if !ok {
		t.Fatalf("expected ToolExecutionEndMsg, got %T", msg)
	}
	if tee.ToolCallID != "tool_xyz" {
		t.Errorf("expected toolCallId 'tool_xyz', got %q", tee.ToolCallID)
	}
	if !tee.IsError {
		t.Error("expected isError true")
	}
}

func TestRelayEventToMsg_FinalMessageUpdate(t *testing.T) {
	ev := map[string]any{
		"type": "message_update",
		"message": map[string]any{
			"role": "assistant",
			"id":   "msg_01",
			"content": []any{
				map[string]any{"type": "text", "text": "Final text"},
			},
			"timestamp": float64(99999),
		},
	}

	msg := relayEventToMsg(ev)
	mu, ok := msg.(MessageUpdateMsg)
	if !ok {
		t.Fatalf("expected MessageUpdateMsg (final), got %T", msg)
	}
	if mu.Role != "assistant" {
		t.Errorf("expected role 'assistant', got %q", mu.Role)
	}
}

// --- Full streaming lifecycle test ---

func TestStreamingLifecycle(t *testing.T) {
	app := New(nil)

	// 1. message_start → placeholder created
	next, _ := app.Update(MessageStartMsg{MessageID: "msg_01", Role: "assistant"})
	app = next.(App)
	if len(app.state.Messages) != 1 || app.state.Messages[0].Text != "▍" {
		t.Fatal("message_start should create placeholder")
	}

	// 2. streaming deltas → text accumulates
	for i, text := range []string{"Hello", "Hello world", "Hello world!"} {
		content, _ := json.Marshal([]map[string]any{
			{"type": "text", "text": text},
		})
		var blocks []json.RawMessage
		json.Unmarshal(content, &blocks)

		next, _ = app.Update(StreamingDeltaMsg{
			MessageID: "msg_01",
			Role:      "assistant",
			Content:   blocks,
			DeltaType: "text_delta",
		})
		app = next.(App)

		if len(app.state.Messages) != 1 {
			t.Fatalf("delta %d: expected 1 message, got %d", i, len(app.state.Messages))
		}
		if app.state.Messages[0].Text != text {
			t.Errorf("delta %d: expected %q, got %q", i, text, app.state.Messages[0].Text)
		}
	}

	// 3. tool_execution_start
	next, _ = app.Update(ToolExecutionStartMsg{ToolCallID: "tool_01", ToolName: "bash"})
	app = next.(App)
	if len(app.state.ActiveTools) != 1 {
		t.Errorf("expected 1 active tool, got %d", len(app.state.ActiveTools))
	}

	// 4. tool_result
	next, _ = app.Update(ToolResultMsg{ToolName: "bash", Content: "ok"})
	app = next.(App)

	// 5. tool_execution_end
	next, _ = app.Update(ToolExecutionEndMsg{ToolCallID: "tool_01", ToolName: "bash"})
	app = next.(App)
	if len(app.state.ActiveTools) != 0 {
		t.Errorf("expected 0 active tools, got %d", len(app.state.ActiveTools))
	}

	// 6. final message_update → clears streaming
	content, _ := json.Marshal([]map[string]any{
		{"type": "text", "text": "Hello world!"},
	})
	var blocks []json.RawMessage
	json.Unmarshal(content, &blocks)
	next, _ = app.Update(MessageUpdateMsg{
		MessageID: "msg_01",
		Role:      "assistant",
		Content:   blocks,
		Timestamp: 12345,
	})
	app = next.(App)
	if app.state.StreamingMessageID != "" {
		t.Error("expected StreamingMessageID cleared after final message_update")
	}
}

// --- parseRelayJSON tests ---

func TestParseRelayJSON_StreamingDelta(t *testing.T) {
	data := mustJSONBytes(t, map[string]any{
		"type": "message_update",
		"assistantMessageEvent": map[string]any{
			"type":  "text_delta",
			"delta": "Hi",
			"partial": map[string]any{
				"id":      "msg_99",
				"role":    "assistant",
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
		"type":       "tool_execution_start",
		"toolCallId": "tool_01",
		"toolName":   "edit",
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
		"message": map[string]any{
			"id":   "msg_77",
			"role": "assistant",
		},
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

func mustJSONBytes(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// mockComponent is a test implementation of Component.
type mockComponent struct {
	name     string
	viewText string
}

func (m *mockComponent) Name() string                              { return m.name }
func (m *mockComponent) Init() tea.Cmd                             { return nil }
func (m *mockComponent) Update(msg tea.Msg) (Component, tea.Cmd)   { return m, nil }
func (m *mockComponent) View(width, height int) string             { return m.viewText }
