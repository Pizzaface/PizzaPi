package claudewrapper

import (
	"bufio"
	"encoding/json"
	"io"
)

func ParseLine(line []byte) ClaudeEvent {
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(line, &envelope); err != nil {
		return &ParseError{Line: string(line), Message: err.Error()}
	}

	switch envelope.Type {
	case "system":
		var raw struct {
			SessionID         string   `json:"session_id"`
			Subtype           string   `json:"subtype"`
			Tools             []string `json:"tools"`
			Cwd               string   `json:"cwd"`
			Model             string   `json:"model"`
			ClaudeCodeVersion string   `json:"claude_code_version"`
			PermissionMode    string   `json:"permissionMode"`
		}
		if err := json.Unmarshal(line, &raw); err != nil {
			return &ParseError{Line: string(line), Message: err.Error()}
		}
		return &SystemEvent{
			SessionID:         raw.SessionID,
			Subtype:           raw.Subtype,
			Tools:             raw.Tools,
			Cwd:               raw.Cwd,
			Model:             raw.Model,
			ClaudeCodeVersion: raw.ClaudeCodeVersion,
			PermissionMode:    raw.PermissionMode,
		}
	case "stream_event":
		var stream struct {
			Event struct {
				Type string `json:"type"`
			} `json:"event"`
		}
		if err := json.Unmarshal(line, &stream); err != nil {
			return &ParseError{Line: string(line), Message: err.Error()}
		}
		switch stream.Event.Type {
		case "message_start":
			var raw struct {
				Event struct {
					Message struct {
						ID    string `json:"id"`
						Role  string `json:"role"`
						Model string `json:"model"`
						Usage struct {
							InputTokens int `json:"input_tokens"`
						} `json:"usage"`
					} `json:"message"`
				} `json:"event"`
			}
			if err := json.Unmarshal(line, &raw); err != nil {
				return &ParseError{Line: string(line), Message: err.Error()}
			}
			return &MessageStart{MessageID: raw.Event.Message.ID, Role: raw.Event.Message.Role, Model: raw.Event.Message.Model, InputTokens: raw.Event.Message.Usage.InputTokens}
		case "content_block_start":
			var raw struct {
				Event struct {
					Index        int `json:"index"`
					ContentBlock struct {
						Type string `json:"type"`
						ID   string `json:"id"`
						Name string `json:"name"`
					} `json:"content_block"`
				} `json:"event"`
			}
			if err := json.Unmarshal(line, &raw); err != nil {
				return &ParseError{Line: string(line), Message: err.Error()}
			}
			return &ContentBlockStart{Index: raw.Event.Index, BlockType: raw.Event.ContentBlock.Type, ToolID: raw.Event.ContentBlock.ID, ToolName: raw.Event.ContentBlock.Name}
		case "content_block_delta":
			var raw struct {
				Event struct {
					Index int `json:"index"`
					Delta struct {
						Type        string `json:"type"`
						Text        string `json:"text"`
						PartialJSON string `json:"partial_json"`
						Thinking    string `json:"thinking"`
						Signature   string `json:"signature"`
					} `json:"delta"`
				} `json:"event"`
			}
			if err := json.Unmarshal(line, &raw); err != nil {
				return &ParseError{Line: string(line), Message: err.Error()}
			}
			return &ContentBlockDelta{
				Index:       raw.Event.Index,
				DeltaType:   raw.Event.Delta.Type,
				Text:        raw.Event.Delta.Text,
				PartialJSON: raw.Event.Delta.PartialJSON,
				Thinking:    raw.Event.Delta.Thinking,
				Signature:   raw.Event.Delta.Signature,
			}
		case "content_block_stop":
			var raw struct {
				Event struct {
					Index int `json:"index"`
				} `json:"event"`
			}
			if err := json.Unmarshal(line, &raw); err != nil {
				return &ParseError{Line: string(line), Message: err.Error()}
			}
			return &ContentBlockStop{Index: raw.Event.Index}
		case "message_delta":
			var raw struct {
				Event struct {
					Delta struct {
						StopReason string `json:"stop_reason"`
					} `json:"delta"`
					Usage struct {
						OutputTokens int `json:"output_tokens"`
					} `json:"usage"`
				} `json:"event"`
			}
			if err := json.Unmarshal(line, &raw); err != nil {
				return &ParseError{Line: string(line), Message: err.Error()}
			}
			return &MessageDelta{StopReason: raw.Event.Delta.StopReason, OutputTokens: raw.Event.Usage.OutputTokens}
		case "message_stop":
			return &MessageStop{}
		default:
			return &UnknownEvent{RawType: stream.Event.Type, Raw: json.RawMessage(append([]byte(nil), line...))}
		}
	case "assistant":
		var raw struct {
			Message json.RawMessage `json:"message"`
		}
		if err := json.Unmarshal(line, &raw); err != nil {
			return &ParseError{Line: string(line), Message: err.Error()}
		}
		return &AssistantMessage{Message: raw.Message}
	case "tool_use":
		var raw struct {
			ToolUseID string          `json:"tool_use_id"`
			Name      string          `json:"name"`
			Input     json.RawMessage `json:"input"`
		}
		if err := json.Unmarshal(line, &raw); err != nil {
			return &ParseError{Line: string(line), Message: err.Error()}
		}
		return &ToolUseEvent{ToolID: raw.ToolUseID, Name: raw.Name, Input: raw.Input}
	case "tool_result":
		var raw struct {
			ToolUseID string `json:"tool_use_id"`
			Content   string `json:"content"`
			IsError   bool   `json:"is_error"`
		}
		if err := json.Unmarshal(line, &raw); err != nil {
			return &ParseError{Line: string(line), Message: err.Error()}
		}
		return &ToolResultEvent{ToolID: raw.ToolUseID, Content: raw.Content, IsError: raw.IsError}
	case "user":
		// The Claude CLI emits tool results as "user" type messages.
		// Extract the first tool_result content block for convenience.
		var raw struct {
			Message json.RawMessage `json:"message"`
		}
		if err := json.Unmarshal(line, &raw); err != nil {
			return &ParseError{Line: string(line), Message: err.Error()}
		}
		// Extract tool result from message.content[]
		var msg struct {
			Content []struct {
				ToolUseID string `json:"tool_use_id"`
				Type      string `json:"type"`
				Content   string `json:"content"`
				IsError   bool   `json:"is_error"`
			} `json:"content"`
		}
		toolUseID, content := "", ""
		isError := false
		if err := json.Unmarshal(raw.Message, &msg); err == nil {
			for _, c := range msg.Content {
				if c.Type == "tool_result" {
					toolUseID = c.ToolUseID
					content = c.Content
					isError = c.IsError
					break
				}
			}
		}
		return &UserMessage{Message: raw.Message, ToolUseID: toolUseID, Content: content, IsError: isError}
	case "rate_limit_event":
		var raw struct {
			RateLimitInfo struct {
				Status     string `json:"status"`
				ResetsAt   int64  `json:"resetsAt"`
				LimitType  string `json:"rateLimitType"`
				IsOverage  bool   `json:"isUsingOverage"`
			} `json:"rate_limit_info"`
		}
		if err := json.Unmarshal(line, &raw); err != nil {
			return &ParseError{Line: string(line), Message: err.Error()}
		}
		return &RateLimitEvent{
			Status:    raw.RateLimitInfo.Status,
			ResetsAt:  raw.RateLimitInfo.ResetsAt,
			LimitType: raw.RateLimitInfo.LimitType,
			IsOverage: raw.RateLimitInfo.IsOverage,
		}
	case "result":
		var raw struct {
			SessionID    string  `json:"session_id"`
			Subtype      string  `json:"subtype"`
			IsError      bool    `json:"is_error"`
			TotalCostUSD float64 `json:"total_cost_usd"`
			DurationMs   int     `json:"duration_ms"`
			NumTurns     int     `json:"num_turns"`
			StopReason   string  `json:"stop_reason"`
			Result       string  `json:"result"`
			Usage        struct {
				InputTokens  int `json:"input_tokens"`
				OutputTokens int `json:"output_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(line, &raw); err != nil {
			return &ParseError{Line: string(line), Message: err.Error()}
		}
		return &ResultEvent{
			SessionID:    raw.SessionID,
			Subtype:      raw.Subtype,
			IsError:      raw.IsError,
			TotalCostUSD: raw.TotalCostUSD,
			DurationMs:   raw.DurationMs,
			NumTurns:     raw.NumTurns,
			StopReason:   raw.StopReason,
			Result:       raw.Result,
			InputTokens:  raw.Usage.InputTokens,
			OutputTokens: raw.Usage.OutputTokens,
		}
	default:
		return &UnknownEvent{RawType: envelope.Type, Raw: json.RawMessage(append([]byte(nil), line...))}
	}
}

func ParseStream(r io.Reader, events chan<- ClaudeEvent) {
	defer close(events)

	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		events <- ParseLine(scanner.Bytes())
	}
	if err := scanner.Err(); err != nil {
		events <- &ParseError{Message: err.Error()}
	}
}
