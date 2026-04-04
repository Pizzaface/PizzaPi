package tui

import tea "github.com/charmbracelet/bubbletea"

// SessionController abstracts the connection between the TUI and an agent
// session. The TUI doesn't know whether it's talking to a local provider
// (spawning claude CLI directly) or a remote relay session.
//
// Both modes produce the same tea.Msg types (HeartbeatMsg, MessageUpdateMsg,
// ToolResultMsg, etc.) so the TUI's Update/View logic is identical.
type SessionController interface {
	// Start begins the session with the given prompt and returns a tea.Cmd
	// that will produce session events as tea.Msg values.
	Start(prompt string) tea.Cmd

	// SendMessage sends a follow-up message to the running session.
	// Returns a tea.Cmd (may be nil if synchronous).
	SendMessage(text string) tea.Cmd

	// Stop terminates the session.
	Stop()

	// Mode returns "local" or "relay".
	Mode() string
}
