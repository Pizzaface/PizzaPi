package tui

import "github.com/charmbracelet/bubbles/textarea"

// Panel represents which panel is currently focused.
type Panel int

const (
	PanelSidebar Panel = iota
	PanelMain
)

// DisplayMessage is a rendered message shown in the main panel.
type DisplayMessage struct {
	ID        string
	Role      string // "user", "assistant", "tool_result", "system"
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
	Input textarea.Model

	// Which panel is currently focused
	ActivePanel Panel

	// Terminal dimensions
	Width  int
	Height int

	// Session controller (local or relay)
	Session SessionController

	// Connection/session state
	Connected    bool
	Active       bool   // session is actively processing
	IsCompacting bool
	SessionName  string
	ModelID      string
	Cwd          string
	Mode         string // "local" or "relay"

	// Metadata from last result
	InputTokens  int
	OutputTokens int
	CostUSD      float64
	NumTurns     int

	// Streaming state
	ActiveTools        map[string]string // toolCallId → toolName (in-flight tools)
	StreamingMessageID string            // ID of the message currently being streamed

	// Extension components
	Components *ComponentRegistry

	// Prompt history
	PromptHistory []string
	HistoryIndex  int // -1 = not browsing history
}

// newAppState creates an AppState with sensible defaults.
func newAppState(session SessionController) AppState {
	ta := textarea.New()
	ta.Placeholder = "Type a message… (Enter to send, Shift+Enter for newline)"
	ta.Focus()
	ta.CharLimit = 8192
	ta.SetHeight(3)
	ta.ShowLineNumbers = false

	mode := ""
	if session != nil {
		mode = session.Mode()
	}

	return AppState{
		Sessions:      []SessionInfo{},
		Messages:      []DisplayMessage{},
		Input:         ta,
		ActivePanel:   PanelMain,
		ActiveTools:   make(map[string]string),
		Components:    NewComponentRegistry(),
		Session:       session,
		Mode:          mode,
		HistoryIndex:  -1,
		PromptHistory: []string{},
	}
}
