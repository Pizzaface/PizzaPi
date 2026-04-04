// Package adk provides a Provider implementation using Google's Agent Development
// Kit (ADK) Go framework. It drives Gemini (and other ADK-supported models)
// natively via the ADK runner, converting session.Event objects to PizzaPi
// RelayEvents for the TUI and relay pipeline.
package adk

import (
	"fmt"
	"strings"
	"time"

	"google.golang.org/adk/session"
	"google.golang.org/genai"
)

// RelayEvent is a PizzaPi relay-compatible event map.
type RelayEvent = map[string]any

// Adapter converts ADK session.Event objects into PizzaPi RelayEvents.
// It accumulates streaming state (content blocks, message ID) across
// partial events and produces the final message on non-partial events.
type Adapter struct {
	model   AdapterModel
	cwd     string
	seq     int
	started bool

	// Accumulated state for the current assistant message
	currentMessageID string
	contentBlocks    []map[string]any
	messages         []map[string]any // conversation history for session_active

	// Tool name tracking (function call name by ID)
	toolNamesByID map[string]string
}

// AdapterModel holds the provider and model ID.
type AdapterModel struct {
	Provider string
	ID       string
}

// NewAdapter creates a new ADK event adapter.
func NewAdapter(model AdapterModel, cwd string) *Adapter {
	return &Adapter{
		model:         model,
		cwd:           cwd,
		toolNamesByID: make(map[string]string),
	}
}

// HandleEvent converts an ADK session.Event to zero or more RelayEvents.
// Events with Partial=true are streaming deltas; events with Partial=false
// are finalized messages.
func (a *Adapter) HandleEvent(ev *session.Event) []map[string]any {
	if ev == nil || ev.Content == nil {
		return nil
	}

	// Emit initial heartbeat + session_active on first event
	var initEvents []RelayEvent
	if !a.started {
		a.started = true
		initEvents = append(initEvents,
			a.heartbeat(true),
			a.sessionActive(),
		)
	}

	author := ev.Author
	_ = author // available for future multi-agent routing

	var events []RelayEvent
	events = append(events, initEvents...)

	// Determine what kind of content this event carries
	if ev.Partial {
		events = append(events, a.handlePartialEvent(ev)...)
	} else {
		events = append(events, a.handleFinalEvent(ev)...)
	}

	return events
}

// handlePartialEvent processes a streaming (partial) event — text deltas,
// thinking deltas, or function call streaming.
func (a *Adapter) handlePartialEvent(ev *session.Event) []RelayEvent {
	var events []RelayEvent

	for i, part := range ev.Content.Parts {
		if part.Text != "" {
			// Streaming text delta
			a.ensureContentIndex(i)
			a.contentBlocks[i] = map[string]any{"type": "text", "text": part.Text}

			events = append(events, RelayEvent{
				"type": "message_update",
				"assistantMessageEvent": map[string]any{
					"partial":      a.buildPartialMessage(),
					"type":         "text_delta",
					"contentIndex": i,
					"delta":        part.Text,
				},
			})
		}

		if part.Thought {
			// Streaming thinking delta
			a.ensureContentIndex(i)
			text := part.Text
			a.contentBlocks[i] = map[string]any{"type": "thinking", "thinking": text}

			events = append(events, RelayEvent{
				"type": "message_update",
				"assistantMessageEvent": map[string]any{
					"partial":      a.buildPartialMessage(),
					"type":         "thinking_delta",
					"contentIndex": i,
					"delta":        text,
				},
			})
		}

		if part.FunctionCall != nil {
			fc := part.FunctionCall
			a.toolNamesByID[fc.ID] = fc.Name

			// Emit tool_execution_start
			events = append(events, RelayEvent{
				"type":       "tool_execution_start",
				"toolCallId": fc.ID,
				"toolName":   fc.Name,
			})
		}
	}

	return events
}

// handleFinalEvent processes a non-partial (finalized) event — complete
// messages, function calls, or function responses.
func (a *Adapter) handleFinalEvent(ev *session.Event) []RelayEvent {
	var events []RelayEvent

	role := string(ev.Content.Role)

	// Check for function responses (tool results)
	for _, part := range ev.Content.Parts {
		if part.FunctionResponse != nil {
			fr := part.FunctionResponse
			toolName := a.toolNamesByID[fr.ID]

			// Convert response to a content string
			content := formatFunctionResponse(fr.Response)

			toolMsg := RelayEvent{
				"type":       "tool_result_message",
				"role":       "tool_result",
				"toolCallId": fr.ID,
				"toolName":   toolName,
				"content":    content,
				"isError":    false,
				"timestamp":  nowMillis(),
			}
			a.messages = append(a.messages, toolMsg)
			events = append(events, toolMsg)

			events = append(events, RelayEvent{
				"type":       "tool_execution_end",
				"toolCallId": fr.ID,
				"toolName":   toolName,
				"isError":    false,
			})
		}
	}

	// Check for function calls
	for i, part := range ev.Content.Parts {
		if part.FunctionCall != nil {
			fc := part.FunctionCall
			a.toolNamesByID[fc.ID] = fc.Name

			// Emit tool_execution_start for non-partial function calls
			events = append(events, RelayEvent{
				"type":       "tool_execution_start",
				"toolCallId": fc.ID,
				"toolName":   fc.Name,
			})

			a.ensureContentIndex(i)
			a.contentBlocks[i] = map[string]any{
				"type":  "tool_use",
				"id":    fc.ID,
				"name":  fc.Name,
				"input": fc.Args,
			}
		}
	}

	// Check for text content (final assistant message)
	hasText := false
	for i, part := range ev.Content.Parts {
		if part.Text != "" && part.FunctionCall == nil && part.FunctionResponse == nil {
			hasText = true
			a.ensureContentIndex(i)
			if part.Thought {
				a.contentBlocks[i] = map[string]any{"type": "thinking", "thinking": part.Text}
			} else {
				a.contentBlocks[i] = map[string]any{"type": "text", "text": part.Text}
			}
		}
	}

	// Emit finalized assistant message
	if role == "model" && (hasText || len(a.contentBlocks) > 0) {
		msgID := a.currentOrGeneratedMessageID()
		msg := map[string]any{
			"role":      "assistant",
			"id":        msgID,
			"content":   cloneBlocks(a.contentBlocks),
			"timestamp": nowMillis(),
		}

		// message_start if this is a new message
		events = append(events, RelayEvent{
			"type": "message_start",
			"message": map[string]any{
				"role": "assistant",
				"id":   msgID,
			},
		})

		// message_update with message field (final)
		events = append(events, RelayEvent{
			"type":    "message_update",
			"message": msg,
		})

		// message_end
		events = append(events, RelayEvent{
			"type":    "message_end",
			"message": msg,
		})

		// Accumulate for session_active
		a.messages = append(a.messages, msg)

		// Reset for next message
		a.contentBlocks = nil
		a.currentMessageID = ""
	}

	return events
}

// HandleTurnEnd emits events that signal the end of an agent turn.
func (a *Adapter) HandleTurnEnd(inputTokens, outputTokens int, costUSD float64, numTurns int, stopReason string) []map[string]any {
	var events []RelayEvent

	// Session active with accumulated messages
	if len(a.messages) > 0 {
		events = append(events, a.sessionActive())
	}

	// Metadata update
	events = append(events, RelayEvent{
		"type":  "session_metadata_update",
		"model": a.modelMap(),
		"usage": map[string]any{
			"inputTokens":  inputTokens,
			"outputTokens": outputTokens,
		},
		"costUSD":    costUSD,
		"numTurns":   numTurns,
		"stopReason": stopReason,
	})

	// Idle heartbeat
	events = append(events, a.heartbeat(false))

	return events
}

// AddUserMessage adds a user message to the conversation history.
func (a *Adapter) AddUserMessage(text string) {
	a.seq++
	a.messages = append(a.messages, map[string]any{
		"role": "user",
		"content": []any{
			map[string]any{"type": "text", "text": text},
		},
		"messageId": fmt.Sprintf("user_%02d", a.seq),
		"timestamp": nowMillis(),
	})
}

// --- helpers ---

func (a *Adapter) heartbeat(active bool) RelayEvent {
	return RelayEvent{
		"type":         "heartbeat",
		"active":       active,
		"isCompacting": false,
		"ts":           nowMillis(),
		"model":        a.modelMap(),
		"sessionName":  nil,
		"cwd":          a.cwd,
	}
}

func (a *Adapter) sessionActive() RelayEvent {
	return RelayEvent{
		"type": "session_active",
		"state": map[string]any{
			"messages": cloneMessages(a.messages),
			"model":    a.modelMap(),
			"cwd":      a.cwd,
		},
	}
}

func (a *Adapter) modelMap() map[string]any {
	return map[string]any{"provider": a.model.Provider, "id": a.model.ID}
}

func (a *Adapter) currentOrGeneratedMessageID() string {
	if a.currentMessageID == "" {
		a.seq++
		a.currentMessageID = fmt.Sprintf("msg_%02d", a.seq)
	}
	return a.currentMessageID
}

func (a *Adapter) ensureContentIndex(index int) {
	for len(a.contentBlocks) <= index {
		a.contentBlocks = append(a.contentBlocks, nil)
	}
}

func (a *Adapter) buildPartialMessage() map[string]any {
	return map[string]any{
		"role":    "assistant",
		"id":      a.currentOrGeneratedMessageID(),
		"content": cloneBlocks(a.contentBlocks),
	}
}

func cloneBlocks(blocks []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(blocks))
	for _, block := range blocks {
		if block == nil {
			continue
		}
		c := make(map[string]any, len(block))
		for k, v := range block {
			c[k] = v
		}
		out = append(out, c)
	}
	return out
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

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

// formatFunctionResponse converts a genai function response map to a string.
func formatFunctionResponse(resp map[string]any) string {
	if resp == nil {
		return ""
	}
	// Check for common patterns: {"output": "..."} or {"result": "..."}
	if output, ok := resp["output"].(string); ok {
		return output
	}
	if result, ok := resp["result"].(string); ok {
		return result
	}
	// Fall back to a simple key=value representation
	var parts []string
	for k, v := range resp {
		parts = append(parts, fmt.Sprintf("%s: %v", k, v))
	}
	return strings.Join(parts, "\n")
}

// FunctionResponseFromParts extracts function responses from genai content parts.
// Exported for testing.
func FunctionResponseFromParts(parts []*genai.Part) []*genai.FunctionResponse {
	var responses []*genai.FunctionResponse
	for _, p := range parts {
		if p.FunctionResponse != nil {
			responses = append(responses, p.FunctionResponse)
		}
	}
	return responses
}
