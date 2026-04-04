package tui

import (
	"time"

	"github.com/charmbracelet/bubbles/textarea"
)

// DisplayMessage is a rendered message shown in the conversation.
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
	// Message buffer — the conversation
	Messages []DisplayMessage
	// Scroll offset for the message list (lines from bottom)
	ScrollOffset int

	// Input field
	Input textarea.Model

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

	// Streaming state
	ActiveTools        map[string]string // toolCallId → toolName (in-flight tools)
	StreamingMessageID string            // ID of message currently being streamed
	IsStreaming        bool              // true while assistant is generating
	ThinkingStart      time.Time         // when thinking started (for elapsed display)

	// Metadata from last result
	InputTokens  int
	OutputTokens int
	CostUSD      float64
	NumTurns     int

	// Animation tick counter (for spinners, cursor blink)
	TickCount int

	// Prompt history
	PromptHistory []string
	HistoryIndex  int // -1 = not browsing history
}

// newAppState creates an AppState with sensible defaults.
func newAppState(session SessionController) AppState {
	ta := textarea.New()
	ta.Placeholder = "Message… (Enter to send)"
	ta.Focus()
	ta.CharLimit = 8192
	ta.SetHeight(1) // Single-line by default
	ta.ShowLineNumbers = false

	mode := ""
	if session != nil {
		mode = session.Mode()
	}

	return AppState{
		Messages:      []DisplayMessage{},
		Input:         ta,
		ActiveTools:   make(map[string]string),
		Session:       session,
		Mode:          mode,
		HistoryIndex:  -1,
		PromptHistory: []string{},
	}
}
