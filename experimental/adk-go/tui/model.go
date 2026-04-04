package tui

import "github.com/charmbracelet/bubbles/textinput"

// Panel represents which panel is currently focused.
type Panel int

const (
	PanelSidebar Panel = iota
	PanelMain
)

// Session is a placeholder session entry shown in the sidebar.
type Session struct {
	ID   string
	Name string
}

// AppState holds all mutable state for the TUI application.
type AppState struct {
	// Sessions shown in the sidebar
	Sessions []Session
	// ID of the currently active session
	ActiveSessionID string

	// Message buffer shown in the main panel
	Messages []string
	// Scroll offset for the message list (lines from bottom)
	ScrollOffset int

	// Input field for composing messages
	Input textinput.Model

	// Which panel is currently focused
	ActivePanel Panel

	// Terminal dimensions
	Width  int
	Height int
}

// newAppState creates an AppState with sensible defaults.
func newAppState() AppState {
	ti := textinput.New()
	ti.Placeholder = "Type a message…"
	ti.Focus()
	ti.CharLimit = 512

	return AppState{
		Sessions: []Session{
			{ID: "session-1", Name: "Session 1"},
			{ID: "session-2", Name: "Session 2"},
			{ID: "session-3", Name: "Session 3"},
		},
		ActiveSessionID: "session-1",
		Messages:        []string{},
		ScrollOffset:    0,
		Input:           ti,
		ActivePanel:     PanelMain,
	}
}
