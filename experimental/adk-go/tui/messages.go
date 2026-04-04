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

// RelayReconnectMsg is sent when a reconnect timer fires.
type RelayReconnectMsg struct {
	Attempt int
}

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

// StreamingDeltaMsg represents a streaming text/thinking delta from
// assistantMessageEvent. It carries the full accumulated partial message
// so the TUI can upsert it by message ID.
type StreamingDeltaMsg struct {
	MessageID string             // stable ID for upsert
	Role      string             // "assistant"
	Content   []json.RawMessage  // accumulated content blocks (partial message)
	DeltaType string             // "text_delta", "thinking_delta", "toolcall_delta"
	Delta     string             // the incremental text
}

// MessageStartMsg signals a new assistant message is beginning.
type MessageStartMsg struct {
	MessageID string `json:"id"`
	Role      string `json:"role"`
}

// ToolExecutionStartMsg signals a tool call is beginning.
type ToolExecutionStartMsg struct {
	ToolCallID string `json:"toolCallId"`
	ToolName   string `json:"toolName"`
}

// ToolExecutionEndMsg signals a tool call has completed.
type ToolExecutionEndMsg struct {
	ToolCallID string `json:"toolCallId"`
	ToolName   string `json:"toolName"`
	IsError    bool   `json:"isError"`
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
