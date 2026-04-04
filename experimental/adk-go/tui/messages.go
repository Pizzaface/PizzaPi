package tui

import "encoding/json"

// Relay event tea.Msg types. These are produced by the relay connection
// and consumed by the TUI model's Update method.

// RelayConnectedMsg is sent when the relay connection is established.
type RelayConnectedMsg struct{}

// RelayDisconnectedMsg is sent when the relay connection drops.
type RelayDisconnectedMsg struct {
	Reason string
}

// RelayErrorMsg is sent when a relay error occurs.
type RelayErrorMsg struct {
	Err error
}

func (e RelayErrorMsg) Error() string { return e.Err.Error() }

// RelayEventMsg wraps a raw relay event for the TUI to process.
type RelayEventMsg struct {
	Type string
	Data json.RawMessage
}

// HeartbeatMsg represents a parsed heartbeat event from the relay.
type HeartbeatMsg struct {
	Active       bool   `json:"active"`
	IsCompacting bool   `json:"isCompacting"`
	Ts           int64  `json:"ts"`
	SessionName  string `json:"sessionName"`
	Cwd          string `json:"cwd"`
	Model        *struct {
		Provider string `json:"provider"`
		ID       string `json:"id"`
	} `json:"model"`
}

// SessionActiveMsg represents a session_active event with full state snapshot.
type SessionActiveMsg struct {
	State struct {
		Messages []json.RawMessage `json:"messages"`
		Model    *struct {
			Provider string `json:"provider"`
			ID       string `json:"id"`
		} `json:"model"`
		Cwd string `json:"cwd"`
	} `json:"state"`
}

// MessageUpdateMsg represents a streaming message_update event.
type MessageUpdateMsg struct {
	Role      string             `json:"role"`
	Content   []json.RawMessage  `json:"content"`
	MessageID string             `json:"messageId"`
	Timestamp int64              `json:"timestamp"`
}

// ToolResultMsg represents a tool_result_message event.
type ToolResultMsg struct {
	Role       string `json:"role"`
	ToolCallID string `json:"toolCallId"`
	ToolName   string `json:"toolName"`
	Content    any    `json:"content"`
	IsError    bool   `json:"isError"`
	Timestamp  int64  `json:"timestamp"`
}

// SessionMetadataMsg represents a session_metadata_update event.
type SessionMetadataMsg struct {
	Model *struct {
		Provider string `json:"provider"`
		ID       string `json:"id"`
	} `json:"model"`
	Usage *struct {
		InputTokens  int `json:"inputTokens"`
		OutputTokens int `json:"outputTokens"`
	} `json:"usage"`
	CostUSD    float64 `json:"costUSD"`
	DurationMs int64   `json:"durationMs"`
	NumTurns   int     `json:"numTurns"`
	StopReason string  `json:"stopReason"`
}

// SessionListMsg carries an updated list of sessions from the relay.
type SessionListMsg struct {
	Sessions []SessionInfo
}

// SessionInfo is a session entry for the sidebar.
type SessionInfo struct {
	ID     string `json:"sessionId"`
	Name   string `json:"name"`
	Active bool   `json:"active"`
	Cwd    string `json:"cwd"`
}
