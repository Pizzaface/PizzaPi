package tui

import (
	"encoding/json"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// TestModelDefaults verifies that a new App initialises with correct defaults.
func TestModelDefaults(t *testing.T) {
	app := New("http://localhost:7492", "test-key", "")
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
	if s.RelayURL != "http://localhost:7492" {
		t.Errorf("expected relay URL to be set")
	}
	if s.Components == nil {
		t.Error("expected non-nil component registry")
	}
}

// TestQuitKeyFromSidebar verifies that 'q' quits when sidebar is focused.
func TestQuitKeyFromSidebar(t *testing.T) {
	app := New("", "", "")
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
	app := New("", "", "")
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
	app := New("", "", "")
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
	app := New("", "", "")
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
	app := New("", "", "")
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
	app := New("", "", "")
	app.state.Input.SetValue("   ")

	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyEnter})
	app = next.(App)

	if len(app.state.Messages) != 0 {
		t.Errorf("expected no messages for blank input, got %d", len(app.state.Messages))
	}
}

// TestViewRendersWithoutPanic verifies View() works.
func TestViewRendersWithoutPanic(t *testing.T) {
	app := New("", "", "")
	next, _ := app.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	app = next.(App)

	out := app.View()
	if strings.TrimSpace(out) == "" {
		t.Error("expected non-empty view output")
	}
}

// TestScrollUp verifies Up increments scroll offset.
func TestScrollUp(t *testing.T) {
	app := New("", "", "")
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
	app := New("", "", "")
	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyDown})
	app = next.(App)
	if app.state.ScrollOffset != 0 {
		t.Errorf("expected scroll offset 0, got %d", app.state.ScrollOffset)
	}
}

// TestRelayConnectedMsg sets connected state.
func TestRelayConnectedMsg(t *testing.T) {
	app := New("", "", "")
	next, _ := app.Update(RelayConnectedMsg{})
	app = next.(App)
	if !app.state.Connected {
		t.Error("expected Connected to be true")
	}
}

// TestRelayDisconnectedMsg clears state.
func TestRelayDisconnectedMsg(t *testing.T) {
	app := New("", "", "")
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
	app := New("", "", "")
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
	app := New("", "", "")

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
	app := New("", "", "")
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
	app := New("", "", "")
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
	app := New("", "", "").
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

// mockComponent is a test implementation of Component.
type mockComponent struct {
	name     string
	viewText string
}

func (m *mockComponent) Name() string                              { return m.name }
func (m *mockComponent) Init() tea.Cmd                             { return nil }
func (m *mockComponent) Update(msg tea.Msg) (Component, tea.Cmd)   { return m, nil }
func (m *mockComponent) View(width, height int) string             { return m.viewText }
