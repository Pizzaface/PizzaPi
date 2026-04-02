package claudewrapper

import (
	"encoding/json"
	"fmt"
	"time"
)

// RelayEvent is a PizzaPi relay-compatible event as a map.
type RelayEvent map[string]any

// Adapter accumulates streaming state and converts Claude events to relay events.
type Adapter struct {
	currentMessageID string
	model            AdapterModel
	cwd              string
	contentBlocks    []map[string]any
	toolInputBuffers map[int]string
	toolUseBlocks    map[int]toolUseMeta
	toolNamesByID    map[string]string
	seq              int
}

type AdapterModel struct {
	Provider string
	ID       string
}

type toolUseMeta struct {
	id   string
	name string
}

func NewAdapter() *Adapter {
	return &Adapter{
		toolInputBuffers: map[int]string{},
		toolUseBlocks:    map[int]toolUseMeta{},
		toolNamesByID:    map[string]string{},
	}
}

func (a *Adapter) HandleEvent(ev ClaudeEvent) []RelayEvent {
	switch e := ev.(type) {
	case *SystemEvent:
		a.model = AdapterModel{Provider: "anthropic", ID: e.Model}
		a.cwd = e.Cwd
		return []RelayEvent{
			// Heartbeat to signal the session is alive
			{
				"type":         "heartbeat",
				"active":       true,
				"isCompacting": false,
				"ts":           nowMillis(),
				"model":        a.modelMap(),
				"sessionName":  nil,
				"cwd":          e.Cwd,
			},
			// session_active snapshot so the UI unblocks message rendering.
			// Without this, the UI waits for session_active/agent_end before
			// displaying any message_update events.
			{
				"type":     "session_active",
				"messages": []any{},
				"model":    a.modelMap(),
				"cwd":      e.Cwd,
				"metadata": map[string]any{
					"model":    a.modelMap(),
					"cwd":      e.Cwd,
					"todoList": nil,
				},
			},
		}
	case *MessageStart:
		a.currentMessageID = e.MessageID
		if a.currentMessageID == "" {
			a.currentMessageID = a.nextMessageID()
		}
		if e.Model != "" {
			a.model = AdapterModel{Provider: "anthropic", ID: e.Model}
		}
		a.contentBlocks = nil
		a.toolInputBuffers = map[int]string{}
		a.toolUseBlocks = map[int]toolUseMeta{}
		return nil
	case *ContentBlockStart:
		a.ensureContentIndex(e.Index)
		switch e.BlockType {
		case "text":
			a.contentBlocks[e.Index] = map[string]any{"type": "text", "text": ""}
		case "tool_use":
			a.toolUseBlocks[e.Index] = toolUseMeta{id: e.ToolID, name: e.ToolName}
			a.toolInputBuffers[e.Index] = ""
			a.toolNamesByID[e.ToolID] = e.ToolName
		case "thinking":
			a.contentBlocks[e.Index] = map[string]any{"type": "thinking", "thinking": ""}
		}
		return nil
	case *ContentBlockDelta:
		switch e.DeltaType {
		case "text_delta":
			a.ensureContentIndex(e.Index)
			if a.contentBlocks[e.Index] == nil {
				a.contentBlocks[e.Index] = map[string]any{"type": "text", "text": ""}
			}
			text, _ := a.contentBlocks[e.Index]["text"].(string)
			a.contentBlocks[e.Index]["text"] = text + e.Text
			return []RelayEvent{a.messageUpdate(false)}
		case "thinking_delta":
			a.ensureContentIndex(e.Index)
			if a.contentBlocks[e.Index] == nil {
				a.contentBlocks[e.Index] = map[string]any{"type": "thinking", "thinking": ""}
			}
			thinking, _ := a.contentBlocks[e.Index]["thinking"].(string)
			a.contentBlocks[e.Index]["thinking"] = thinking + e.Thinking
			return nil // thinking streamed but not relayed until final message
		case "signature_delta":
			return nil // signature verification data — not relayed
		case "input_json_delta":
			a.toolInputBuffers[e.Index] += e.PartialJSON
		}
		return nil
	case *ContentBlockStop:
		if meta, ok := a.toolUseBlocks[e.Index]; ok {
			a.ensureContentIndex(e.Index)
			input := map[string]any{}
			if raw := a.toolInputBuffers[e.Index]; raw != "" {
				if err := json.Unmarshal([]byte(raw), &input); err != nil {
					input = map[string]any{"_raw": raw, "_parseError": err.Error()}
				}
			}
			a.contentBlocks[e.Index] = map[string]any{
				"type":  "tool_use",
				"id":    meta.id,
				"name":  meta.name,
				"input": input,
			}
		}
		return nil
	case *MessageDelta:
		return nil
	case *MessageStop:
		return nil
	case *AssistantMessage:
		if len(e.Message) == 0 {
			return nil
		}
		var payload struct {
			ID      string           `json:"id"`
			Role    string           `json:"role"`
			Content []map[string]any `json:"content"`
		}
		if err := json.Unmarshal(e.Message, &payload); err == nil {
			if len(payload.Content) == 0 {
				return nil // skip empty assistant events
			}
			if payload.ID != "" {
				a.currentMessageID = payload.ID
			}
			a.contentBlocks = cloneBlocks(payload.Content)
			for _, block := range payload.Content {
				if blockType, _ := block["type"].(string); blockType == "tool_use" {
					id, _ := block["id"].(string)
					name, _ := block["name"].(string)
					if id != "" && name != "" {
						a.toolNamesByID[id] = name
					}
				}
			}
		}
		return []RelayEvent{a.messageUpdate(true)}
	case *ToolUseEvent:
		var input any = map[string]any{}
		if len(e.Input) > 0 {
			_ = json.Unmarshal(e.Input, &input)
		}
		a.toolNamesByID[e.ToolID] = e.Name
		return []RelayEvent{{
			"type":      "message_update",
			"role":      "assistant",
			"content":   []map[string]any{{"type": "tool_use", "id": e.ToolID, "name": e.Name, "input": input}},
			"messageId": a.currentOrGeneratedMessageID(),
		}}
	case *ToolResultEvent:
		return []RelayEvent{{
			"type":       "tool_result_message",
			"role":       "tool_result",
			"toolCallId": e.ToolID,
			"toolName":   a.toolNamesByID[e.ToolID],
			"content":    e.Content,
			"isError":    e.IsError,
			"timestamp":  nowMillis(),
		}}
	case *UserMessage:
		// The Claude CLI reports tool results as "user" messages.
		// Map them to tool_result_message for PizzaPi.
		if e.ToolUseID != "" {
			return []RelayEvent{{
				"type":       "tool_result_message",
				"role":       "tool_result",
				"toolCallId": e.ToolUseID,
				"toolName":   a.toolNamesByID[e.ToolUseID],
				"content":    e.Content,
				"isError":    e.IsError,
				"timestamp":  nowMillis(),
			}}
		}
		return nil
	case *RateLimitEvent:
		// Rate limit info is logged but not forwarded to the relay.
		return nil
	case *ResultEvent:
		if a.model.ID == "" {
			a.model = AdapterModel{Provider: "anthropic", ID: ""}
		}
		return []RelayEvent{{
			"type":  "session_metadata_update",
			"model": a.modelMap(),
			"usage": map[string]any{
				"inputTokens":  e.InputTokens,
				"outputTokens": e.OutputTokens,
			},
			"costUSD":    e.TotalCostUSD,
			"durationMs": e.DurationMs,
			"numTurns":   e.NumTurns,
			"stopReason": e.StopReason,
		}}
	case *UnknownEvent, *ParseError:
		return nil
	default:
		return nil
	}
}

func (a *Adapter) currentOrGeneratedMessageID() string {
	if a.currentMessageID == "" {
		a.currentMessageID = a.nextMessageID()
	}
	return a.currentMessageID
}

func (a *Adapter) nextMessageID() string {
	a.seq++
	return fmt.Sprintf("msg_%02d", a.seq)
}

func (a *Adapter) ensureContentIndex(index int) {
	for len(a.contentBlocks) <= index {
		a.contentBlocks = append(a.contentBlocks, nil)
	}
}

func (a *Adapter) messageUpdate(includeTimestamp bool) RelayEvent {
	event := RelayEvent{
		"type":      "message_update",
		"role":      "assistant",
		"content":   cloneBlocks(a.contentBlocks),
		"messageId": a.currentOrGeneratedMessageID(),
	}
	if includeTimestamp {
		event["timestamp"] = nowMillis()
	}
	return event
}

func (a *Adapter) modelMap() map[string]any {
	return map[string]any{"provider": a.model.Provider, "id": a.model.ID}
}

func cloneBlocks(blocks []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(blocks))
	for _, block := range blocks {
		if block == nil {
			continue
		}
		copyBlock := make(map[string]any, len(block))
		for k, v := range block {
			copyBlock[k] = v
		}
		out = append(out, copyBlock)
	}
	return out
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}
