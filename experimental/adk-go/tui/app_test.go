package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// TestModelDefaults verifies that a new App initialises with correct defaults.
func TestModelDefaults(t *testing.T) {
	app := New()
	s := app.state

	if len(s.Sessions) == 0 {
		t.Error("expected non-empty session list")
	}
	if s.ActiveSessionID == "" {
		t.Error("expected a non-empty active session ID")
	}
	if len(s.Messages) != 0 {
		t.Errorf("expected empty message buffer, got %d messages", len(s.Messages))
	}
	if s.ScrollOffset != 0 {
		t.Errorf("expected scroll offset 0, got %d", s.ScrollOffset)
	}
	if s.ActivePanel != PanelMain {
		t.Errorf("expected PanelMain as default, got %v", s.ActivePanel)
	}
}

// TestQuitKey verifies that pressing "q" while in PanelSidebar produces a tea.Quit command.
func TestQuitKey(t *testing.T) {
	app := New()
	// Switch to sidebar first — 'q' only quits from there.
	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyTab})
	app = next.(App)
	if app.state.ActivePanel != PanelSidebar {
		t.Fatalf("expected PanelSidebar after Tab, got %v", app.state.ActivePanel)
	}

	_, cmd := app.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("q")})
	if cmd == nil {
		t.Fatal("expected a command, got nil")
	}
	// Execute the command and check it is tea.Quit.
	msg := cmd()
	if _, ok := msg.(tea.QuitMsg); !ok {
		t.Errorf("expected tea.QuitMsg, got %T", msg)
	}
}

// TestQKeyInMainPanelDoesNotQuit verifies that 'q' while PanelMain is active
// does NOT quit — it should be forwarded to the text input instead.
func TestQKeyInMainPanelDoesNotQuit(t *testing.T) {
	app := New()
	// Default is PanelMain, input is focused.
	if app.state.ActivePanel != PanelMain {
		t.Fatalf("expected PanelMain initially, got %v", app.state.ActivePanel)
	}

	_, cmd := app.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("q")})
	// cmd may be nil (no-op) or a non-quit command from the input component.
	// It must NOT be tea.Quit.
	if cmd != nil {
		msg := cmd()
		if _, isQuit := msg.(tea.QuitMsg); isQuit {
			t.Error("pressing 'q' in PanelMain must not quit the app")
		}
	}
}

// TestCtrlCQuit verifies that ctrl+c also produces a tea.Quit command.
func TestCtrlCQuit(t *testing.T) {
	app := New()
	_, cmd := app.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	if cmd == nil {
		t.Fatal("expected a command, got nil")
	}
	msg := cmd()
	if _, ok := msg.(tea.QuitMsg); !ok {
		t.Errorf("expected tea.QuitMsg, got %T", msg)
	}
}

// TestTabTogglesPanel verifies that Tab switches the active panel.
func TestTabTogglesPanel(t *testing.T) {
	app := New()
	if app.state.ActivePanel != PanelMain {
		t.Fatalf("expected PanelMain initially")
	}

	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyTab})
	app = next.(App)
	if app.state.ActivePanel != PanelSidebar {
		t.Errorf("expected PanelSidebar after first Tab, got %v", app.state.ActivePanel)
	}

	next, _ = app.Update(tea.KeyMsg{Type: tea.KeyTab})
	app = next.(App)
	if app.state.ActivePanel != PanelMain {
		t.Errorf("expected PanelMain after second Tab, got %v", app.state.ActivePanel)
	}
}

// TestEnterAppendsMessage verifies that Enter appends the input text and clears the field.
func TestEnterAppendsMessage(t *testing.T) {
	app := New()

	// Inject text directly into the state's input value.
	app.state.Input.SetValue("hello world")

	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyEnter})
	app = next.(App)

	if len(app.state.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(app.state.Messages))
	}
	if app.state.Messages[0] != "hello world" {
		t.Errorf("expected 'hello world', got %q", app.state.Messages[0])
	}
	if app.state.Input.Value() != "" {
		t.Errorf("expected empty input after Enter, got %q", app.state.Input.Value())
	}
}

// TestEnterEmptyNoMessage verifies that Enter with blank input does not append.
func TestEnterEmptyNoMessage(t *testing.T) {
	app := New()
	app.state.Input.SetValue("   ")

	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyEnter})
	app = next.(App)

	if len(app.state.Messages) != 0 {
		t.Errorf("expected no messages for blank input, got %d", len(app.state.Messages))
	}
}

// TestViewRendersWithoutPanic verifies that View() returns a non-empty string.
func TestViewRendersWithoutPanic(t *testing.T) {
	app := New()
	// Set a window size so view renders real content.
	next, _ := app.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	app = next.(App)

	out := app.View()
	if strings.TrimSpace(out) == "" {
		t.Error("expected non-empty view output")
	}
}

// TestScrollUp verifies that pressing Up increments the scroll offset.
func TestScrollUp(t *testing.T) {
	app := New()
	app.state.Messages = []string{"a", "b", "c"}

	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyUp})
	app = next.(App)
	if app.state.ScrollOffset != 1 {
		t.Errorf("expected scroll offset 1 after Up, got %d", app.state.ScrollOffset)
	}
}

// TestScrollDownClamp verifies that Down does not go below 0.
func TestScrollDownClamp(t *testing.T) {
	app := New()
	// ScrollOffset is already 0; pressing Down should keep it at 0.
	next, _ := app.Update(tea.KeyMsg{Type: tea.KeyDown})
	app = next.(App)
	if app.state.ScrollOffset != 0 {
		t.Errorf("expected scroll offset 0, got %d", app.state.ScrollOffset)
	}
}
