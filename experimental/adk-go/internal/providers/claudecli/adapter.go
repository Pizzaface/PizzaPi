package claudecli

import (
	"encoding/json"
	"fmt"
	"time"
)

// RelayEvent is a PizzaPi relay-compatible event as a map.
type RelayEvent map[string]any

// Adapter accumulates streaming state and converts Claude events to relay events.
type Adapter struct {
	currentMessageID  string
	model             AdapterModel
	cwd               string
	initialized       bool // true after first system event
	contentBlocks     []map[string]any
	messages          []map[string]any // accumulated conversation messages
	pendingUserPrompt string           // user prompt to add when system event arrives
	toolInputBuffers  map[int]string
	toolUseBlocks     map[int]toolUseMeta
	toolNamesByID     map[string]string
	seq               int
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

// SetUserPrompt records a user prompt. It will be added to the message
// list when the next system event arrives (Claude emits a system event
// at the start of every turn, including follow-ups).
func (a *Adapter) SetUserPrompt(prompt string) {
	a.pendingUserPrompt = prompt
}

func (a *Adapter) HandleEvent(ev ClaudeEvent) []RelayEvent {
	switch e := ev.(type) {
	case *SystemEvent:
		a.model = AdapterModel{Provider: "anthropic", ID: e.Model}
		a.cwd = e.Cwd
		a.initialized = true
		// If there's a pending user prompt, add it to the message list now
		if a.pendingUserPrompt != "" {
			a.seq++
			a.messages = append(a.messages, map[string]any{
				"role": "user",
				"content": []any{
					map[string]any{"type": "text", "text": a.pendingUserPrompt},
				},
				"messageId": fmt.Sprintf("user_%02d", a.seq),
				"timestamp": nowMillis(),
			})
			a.pendingUserPrompt = ""
		}
		return []RelayEvent{
			{
				"type":         "heartbeat",
				"active":       true,
				"isCompacting": false,
				"ts":           nowMillis(),
				"model":        a.modelMap(),
				"sessionName":  nil,
				"cwd":          e.Cwd,
			},
			{
				"type": "session_active",
				"state": map[string]any{
					"messages": cloneMessages(a.messages),
					"model":    a.modelMap(),
					"cwd":      e.Cwd,
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

		// Emit message_start — the UI uses this to show the message appearing.
		return []RelayEvent{{
			"type": "message_start",
			"message": map[string]any{
				"role": "assistant",
				"id":   a.currentMessageID,
			},
		}}

	case *ContentBlockStart:
		a.ensureContentIndex(e.Index)
		var events []RelayEvent
		switch e.BlockType {
		case "text":
			a.contentBlocks[e.Index] = map[string]any{"type": "text", "text": ""}
		case "tool_use":
			a.toolUseBlocks[e.Index] = toolUseMeta{id: e.ToolID, name: e.ToolName}
			a.toolInputBuffers[e.Index] = ""
			a.toolNamesByID[e.ToolID] = e.ToolName
			// Emit tool_execution_start — the UI uses this for streaming tool indicators.
			events = append(events, RelayEvent{
				"type":       "tool_execution_start",
				"toolCallId": e.ToolID,
				"toolName":   e.ToolName,
			})
		case "thinking":
			a.contentBlocks[e.Index] = map[string]any{"type": "thinking", "thinking": ""}
		}
		return events

	case *ContentBlockDelta:
		switch e.DeltaType {
		case "text_delta":
			a.ensureContentIndex(e.Index)
			if a.contentBlocks[e.Index] == nil {
				a.contentBlocks[e.Index] = map[string]any{"type": "text", "text": ""}
			}
			text, _ := a.contentBlocks[e.Index]["text"].(string)
			a.contentBlocks[e.Index]["text"] = text + e.Text
			// Emit streaming delta with assistantMessageEvent wrapper.
			// The UI detects assistantMessageEvent.partial for RAF-debounced rendering.
			return []RelayEvent{{
				"type": "message_update",
				"assistantMessageEvent": map[string]any{
					"partial":      a.buildPartialMessage(),
					"type":         "text_delta",
					"contentIndex": e.Index,
					"delta":        e.Text,
				},
			}}
		case "thinking_delta":
			a.ensureContentIndex(e.Index)
			if a.contentBlocks[e.Index] == nil {
				a.contentBlocks[e.Index] = map[string]any{"type": "thinking", "thinking": ""}
			}
			thinking, _ := a.contentBlocks[e.Index]["thinking"].(string)
			a.contentBlocks[e.Index]["thinking"] = thinking + e.Thinking
			// Emit thinking delta with assistantMessageEvent wrapper.
			return []RelayEvent{{
				"type": "message_update",
				"assistantMessageEvent": map[string]any{
					"partial":      a.buildPartialMessage(),
					"type":         "thinking_delta",
					"contentIndex": e.Index,
					"delta":        e.Thinking,
				},
			}}
		case "signature_delta":
			return nil
		case "input_json_delta":
			a.toolInputBuffers[e.Index] += e.PartialJSON
			// Emit toolcall_delta for streaming tool input display.
			return []RelayEvent{{
				"type": "message_update",
				"assistantMessageEvent": map[string]any{
					"partial":      a.buildPartialMessage(),
					"type":         "toolcall_delta",
					"contentIndex": e.Index,
					"delta":        e.PartialJSON,
				},
			}}
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
				return nil
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

		// Build the finalized message object.
		msg := a.buildFinalMessage()

		// Emit message_update (with message field for upsert) and
		// message_end (for finalization and partial eviction).
		return []RelayEvent{
			{
				"type":    "message_update",
				"message": msg,
			},
			{
				"type":    "message_end",
				"message": msg,
			},
		}

	case *ToolUseEvent:
		var input any = map[string]any{}
		if len(e.Input) > 0 {
			_ = json.Unmarshal(e.Input, &input)
		}
		a.toolNamesByID[e.ToolID] = e.Name
		// Emit as message_update with message field containing tool_use block.
		return []RelayEvent{{
			"type": "message_update",
			"message": map[string]any{
				"role":    "assistant",
				"id":      a.currentOrGeneratedMessageID(),
				"content": []map[string]any{{"type": "tool_use", "id": e.ToolID, "name": e.Name, "input": input}},
			},
		}}

	case *ToolResultEvent:
		toolMsg := RelayEvent{
			"type":       "tool_result_message",
			"role":       "tool_result",
			"toolCallId": e.ToolID,
			"toolName":   a.toolNamesByID[e.ToolID],
			"content":    e.Content,
			"isError":    e.IsError,
			"timestamp":  nowMillis(),
		}
		a.messages = append(a.messages, map[string]any(toolMsg))

		events := []RelayEvent{toolMsg}

		// Emit tool_execution_end for the UI to clear streaming indicators.
		events = append(events, RelayEvent{
			"type":       "tool_execution_end",
			"toolCallId": e.ToolID,
			"toolName":   a.toolNamesByID[e.ToolID],
			"isError":    e.IsError,
		})

		return events

	case *UserMessage:
		if e.ToolUseID != "" {
			toolMsg := RelayEvent{
				"type":       "tool_result_message",
				"role":       "tool_result",
				"toolCallId": e.ToolUseID,
				"toolName":   a.toolNamesByID[e.ToolUseID],
				"content":    e.Content,
				"isError":    e.IsError,
				"timestamp":  nowMillis(),
			}
			a.messages = append(a.messages, map[string]any(toolMsg))

			events := []RelayEvent{toolMsg}
			events = append(events, RelayEvent{
				"type":       "tool_execution_end",
				"toolCallId": e.ToolUseID,
				"toolName":   a.toolNamesByID[e.ToolUseID],
				"isError":    e.IsError,
			})
			return events
		}
		return nil

	case *RateLimitEvent:
		return nil

	case *ResultEvent:
		if a.model.ID == "" {
			a.model = AdapterModel{Provider: "anthropic", ID: ""}
		}

		events := []RelayEvent{}

		// Emit session_active with the assistant message to persist state
		if len(a.contentBlocks) > 0 {
			assistantMsg := map[string]any{
				"role":      "assistant",
				"content":   cloneBlocks(a.contentBlocks),
				"id":        a.currentOrGeneratedMessageID(),
				"timestamp": nowMillis(),
			}
			a.messages = append(a.messages, assistantMsg)
			events = append(events, RelayEvent{
				"type": "session_active",
				"state": map[string]any{
					"messages": cloneMessages(a.messages),
					"model":    a.modelMap(),
					"cwd":      a.cwd,
				},
			})
		}

		events = append(events, RelayEvent{
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
		})

		// Signal that the agent is idle (turn complete)
		events = append(events, RelayEvent{
			"type":         "heartbeat",
			"active":       false,
			"isCompacting": false,
			"ts":           nowMillis(),
			"model":        a.modelMap(),
			"cwd":          a.cwd,
		})

		return events

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

// buildPartialMessage builds the current accumulated assistant message
// (in-progress, no timestamp) for streaming delta events.
func (a *Adapter) buildPartialMessage() map[string]any {
	return map[string]any{
		"role":    "assistant",
		"id":      a.currentOrGeneratedMessageID(),
		"content": cloneBlocks(a.contentBlocks),
	}
}

// buildFinalMessage builds the finalized assistant message (with timestamp).
func (a *Adapter) buildFinalMessage() map[string]any {
	return map[string]any{
		"role":      "assistant",
		"id":        a.currentOrGeneratedMessageID(),
		"content":   cloneBlocks(a.contentBlocks),
		"timestamp": nowMillis(),
	}
}

func (a *Adapter) modelMap() map[string]any {
	return map[string]any{"provider": a.model.Provider, "id": a.model.ID}
}

// ModelMap returns the current model as a map (exported for callers).
func (a *Adapter) ModelMap() map[string]any {
	return a.modelMap()
}

func cloneMessages(msgs []map[string]any) []any {
	out := make([]any, 0, len(msgs))
	for _, msg := range msgs {
		c := make(map[string]any, len(msg))
		for k, v := range msg {
			c[k] = v
		}
		out = append(out, c)
	}
	return out
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
