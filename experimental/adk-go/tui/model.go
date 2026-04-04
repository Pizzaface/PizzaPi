package tui

import "github.com/charmbracelet/bubbles/textinput"

// Panel represents which panel is currently focused.
type Panel int

const (
	PanelSidebar Panel = iota
	PanelMain
)

// DisplayMessage is a rendered message shown in the main panel.
type DisplayMessage struct {
	ID        string
	Role      string // "user", "assistant", "tool_result"
	Text      string // rendered text content
	ToolName  string // for tool results
	IsError   bool   // for tool results
	Timestamp int64
}

// AppState holds all mutable state for the TUI application.
type AppState struct {
	// Sessions shown in the sidebar
	Sessions []SessionInfo
	// ID of the currently active session
	ActiveSessionID string

	// Message buffer shown in the main panel
	Messages []DisplayMessage
	// Scroll offset for the message list (lines from bottom)
	ScrollOffset int

	// Input field for composing messages
	Input textinput.Model

	// Which panel is currently focused
	ActivePanel Panel

	// Terminal dimensions
	Width  int
	Height int

	// Relay connection state
	Connected    bool
	Active       bool   // session is actively processing
	IsCompacting bool
	SessionName  string
	ModelID      string
	Cwd          string

	// Metadata from last result
	InputTokens  int
	OutputTokens int
	CostUSD      float64
	NumTurns     int

	// Extension components
	Components *ComponentRegistry

	// Relay connection config (set at init, used by relay commands)
	RelayURL  string
	APIKey    string
	SessionID string // specific session to join (empty = watch all)
}

// newAppState creates an AppState with sensible defaults.
func newAppState(relayURL, apiKey, sessionID string) AppState {
	ti := textinput.New()
	ti.Placeholder = "Type a message…"
	ti.Focus()
	ti.CharLimit = 4096

	return AppState{
		Sessions:    []SessionInfo{},
		Messages:    []DisplayMessage{},
		Input:       ti,
		ActivePanel: PanelMain,
		Components:  NewComponentRegistry(),
		RelayURL:    relayURL,
		APIKey:      apiKey,
		SessionID:   sessionID,
	}
}
