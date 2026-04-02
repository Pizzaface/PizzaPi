package claudewrapper

import "encoding/json"

type ClaudeEvent interface {
	EventType() string
}

type SystemEvent struct {
	SessionID        string   `json:"session_id"`
	Subtype          string   `json:"subtype"` // "init"
	Tools            []string `json:"tools"`
	Cwd              string   `json:"cwd"`
	Model            string   `json:"model"`
	ClaudeCodeVersion string  `json:"claude_code_version"`
	PermissionMode   string   `json:"permission_mode"`
}

func (*SystemEvent) EventType() string { return "system" }

type ContentBlockDelta struct {
	Index       int    `json:"index"`
	DeltaType   string `json:"delta_type"`
	Text        string `json:"text"`
	PartialJSON string `json:"partial_json"`
}

func (*ContentBlockDelta) EventType() string { return "content_block_delta" }

type ContentBlockStart struct {
	Index     int    `json:"index"`
	BlockType string `json:"block_type"`
	ToolID    string `json:"tool_id"`
	ToolName  string `json:"tool_name"`
}

func (*ContentBlockStart) EventType() string { return "content_block_start" }

type ContentBlockStop struct {
	Index int `json:"index"`
}

func (*ContentBlockStop) EventType() string { return "content_block_stop" }

type MessageStart struct {
	MessageID   string `json:"message_id"`
	Role        string `json:"role"`
	Model       string `json:"model"`
	InputTokens int    `json:"input_tokens"`
}

func (*MessageStart) EventType() string { return "message_start" }

type MessageDelta struct {
	StopReason  string `json:"stop_reason"`
	OutputTokens int   `json:"output_tokens"`
}

func (*MessageDelta) EventType() string { return "message_delta" }

type MessageStop struct{}

func (*MessageStop) EventType() string { return "message_stop" }

type AssistantMessage struct {
	Message json.RawMessage `json:"message"`
}

func (*AssistantMessage) EventType() string { return "assistant" }

type ToolUseEvent struct {
	ToolID string          `json:"tool_id"`
	Name   string          `json:"name"`
	Input  json.RawMessage `json:"input"`
}

func (*ToolUseEvent) EventType() string { return "tool_use" }

type ToolResultEvent struct {
	ToolID  string `json:"tool_id"`
	Content string `json:"content"`
	IsError bool   `json:"is_error"`
}

func (*ToolResultEvent) EventType() string { return "tool_result" }

type ResultEvent struct {
	SessionID    string  `json:"session_id"`
	Subtype      string  `json:"subtype"` // "success" or "error"
	IsError      bool    `json:"is_error"`
	TotalCostUSD float64 `json:"total_cost_usd"`
	DurationMs   int     `json:"duration_ms"`
	NumTurns     int     `json:"num_turns"`
	StopReason   string  `json:"stop_reason"`
	Result       string  `json:"result"` // final text result
	InputTokens  int     `json:"input_tokens"`
	OutputTokens int     `json:"output_tokens"`
}

func (*ResultEvent) EventType() string { return "result" }

// RateLimitEvent carries rate limit / quota info from the Claude CLI.
type RateLimitEvent struct {
	Status      string `json:"status"`       // "allowed", "blocked"
	ResetsAt    int64  `json:"resets_at"`
	LimitType   string `json:"limit_type"`   // "five_hour"
	IsOverage   bool   `json:"is_overage"`
}

func (*RateLimitEvent) EventType() string { return "rate_limit_event" }

// UserMessage carries tool results from the CLI (the CLI executes tools
// internally and reports results as "user" type messages).
type UserMessage struct {
	Message json.RawMessage `json:"message"`
	// Extracted tool result metadata for convenience
	ToolUseID string `json:"tool_use_id"`
	Content   string `json:"content"`
	IsError   bool   `json:"is_error"`
}

func (*UserMessage) EventType() string { return "user" }

type UnknownEvent struct {
	RawType string          `json:"raw_type"`
	Raw     json.RawMessage `json:"raw"`
}

func (*UnknownEvent) EventType() string { return "unknown" }

type ParseError struct {
	Line    string `json:"line"`
	Offset  int    `json:"offset"`
	Message string `json:"message"`
}

func (*ParseError) EventType() string { return "parse_error" }
