package tui

import (
	"encoding/json"
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

func update(a App, msg tea.Msg) (tea.Model, tea.Cmd) {
	s := a.state
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.Width = msg.Width
		s.Height = msg.Height

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			return a, tea.Quit

		case "q":
			// Only quit from the sidebar; when the main input is focused 'q' is
			// a regular character.
			if s.ActivePanel == PanelSidebar {
				return a, tea.Quit
			}

		case "tab":
			if s.ActivePanel == PanelMain {
				s.ActivePanel = PanelSidebar
			} else {
				s.ActivePanel = PanelMain
			}
			a.state = s
			return a, nil

		case "enter":
			if s.ActivePanel == PanelMain {
				text := strings.TrimSpace(s.Input.Value())
				if text != "" {
					s.Messages = append(s.Messages, DisplayMessage{
						Role: "user",
						Text: text,
					})
					s.Input.SetValue("")
					s.ScrollOffset = 0

					// Send via relay if connected
					if s.Connected {
						cmds = append(cmds, sendRelayInput(text))
					}
				}
				a.state = s
				return a, tea.Batch(cmds...)
			}

		case "up":
			s.ScrollOffset++
			maxScroll := len(s.Messages) - 1
			if maxScroll < 0 {
				maxScroll = 0
			}
			if s.ScrollOffset > maxScroll {
				s.ScrollOffset = maxScroll
			}
			a.state = s
			return a, nil

		case "down":
			if s.ScrollOffset > 0 {
				s.ScrollOffset--
			}
			a.state = s
			return a, nil
		}

	// --- Relay connection events ---
	case RelayConnectedMsg:
		s.Connected = true
		// Start listening for relay events
		cmds = append(cmds, listenRelay())

	case RelayDisconnectedMsg:
		s.Connected = false
		s.Active = false

	case RelayErrorMsg:
		s.Messages = append(s.Messages, DisplayMessage{
			Role: "system",
			Text: fmt.Sprintf("⚠ Relay error: %v", msg.Err),
		})

	// --- Relay session events ---
	case HeartbeatMsg:
		s.Active = msg.Active
		s.IsCompacting = msg.IsCompacting
		if msg.SessionName != "" {
			s.SessionName = msg.SessionName
		}
		if msg.Cwd != "" {
			s.Cwd = msg.Cwd
		}
		if msg.Model != nil && msg.Model.ID != "" {
			s.ModelID = msg.Model.ID
		}

	case SessionActiveMsg:
		// Full state snapshot — rebuild message list from scratch
		s.Messages = parseMessages(msg.State.Messages)
		if msg.State.Model != nil && msg.State.Model.ID != "" {
			s.ModelID = msg.State.Model.ID
		}
		if msg.State.Cwd != "" {
			s.Cwd = msg.State.Cwd
		}
		s.ScrollOffset = 0

	case MessageUpdateMsg:
		// Streaming update — find existing message by ID or append
		text := extractTextFromContent(msg.Content)
		found := false
		for i := range s.Messages {
			if s.Messages[i].ID == msg.MessageID {
				s.Messages[i].Text = text
				s.Messages[i].Role = msg.Role
				found = true
				break
			}
		}
		if !found {
			s.Messages = append(s.Messages, DisplayMessage{
				ID:        msg.MessageID,
				Role:      msg.Role,
				Text:      text,
				Timestamp: msg.Timestamp,
			})
		}

	case ToolResultMsg:
		content := ""
		switch c := msg.Content.(type) {
		case string:
			content = c
		default:
			if b, err := json.Marshal(c); err == nil {
				content = string(b)
			}
		}
		// Truncate long tool results for display
		if len(content) > 500 {
			content = content[:497] + "..."
		}

		s.Messages = append(s.Messages, DisplayMessage{
			Role:      "tool_result",
			Text:      content,
			ToolName:  msg.ToolName,
			IsError:   msg.IsError,
			Timestamp: msg.Timestamp,
		})

	case SessionMetadataMsg:
		if msg.Model != nil && msg.Model.ID != "" {
			s.ModelID = msg.Model.ID
		}
		if msg.Usage != nil {
			s.InputTokens = msg.Usage.InputTokens
			s.OutputTokens = msg.Usage.OutputTokens
		}
		s.CostUSD = msg.CostUSD
		s.NumTurns = msg.NumTurns

	case SessionListMsg:
		s.Sessions = msg.Sessions
	}

	// After handling any relay event, keep listening for the next one.
	switch msg.(type) {
	case HeartbeatMsg, SessionActiveMsg, MessageUpdateMsg, ToolResultMsg,
		SessionMetadataMsg, SessionListMsg, RelayEventMsg:
		cmds = append(cmds, listenRelay())
	}

	// Forward key messages to the text input when main panel is focused
	if s.ActivePanel == PanelMain {
		if _, ok := msg.(tea.KeyMsg); ok {
			var cmd tea.Cmd
			s.Input, cmd = s.Input.Update(msg)
			if cmd != nil {
				cmds = append(cmds, cmd)
			}
		}
	}

	// Forward to extension components
	for i, c := range s.Components.All() {
		updated, cmd := c.Update(msg)
		s.Components.components[i] = updated
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
	}

	a.state = s
	return a, tea.Batch(cmds...)
}

// parseMessages converts raw JSON messages from a session_active snapshot
// into display messages.
func parseMessages(raw []json.RawMessage) []DisplayMessage {
	var msgs []DisplayMessage
	for _, r := range raw {
		var m struct {
			Role      string            `json:"role"`
			Content   json.RawMessage   `json:"content"`
			MessageID string            `json:"messageId"`
			ToolName  string            `json:"toolName"`
			IsError   bool              `json:"isError"`
			Timestamp int64             `json:"timestamp"`
		}
		if err := json.Unmarshal(r, &m); err != nil {
			continue
		}

		dm := DisplayMessage{
			ID:        m.MessageID,
			Role:      m.Role,
			Timestamp: m.Timestamp,
		}

		if m.Role == "tool_result" {
			dm.ToolName = m.ToolName
			dm.IsError = m.IsError
			dm.Text = string(m.Content)
			if len(dm.Text) > 500 {
				dm.Text = dm.Text[:497] + "..."
			}
		} else {
			// Try parsing content as array of blocks
			var blocks []json.RawMessage
			if err := json.Unmarshal(m.Content, &blocks); err == nil {
				dm.Text = extractTextFromContent(blocks)
			} else {
				// Content might be a plain string
				var text string
				if err := json.Unmarshal(m.Content, &text); err == nil {
					dm.Text = text
				}
			}
		}

		if dm.Text != "" || dm.Role == "tool_result" {
			msgs = append(msgs, dm)
		}
	}
	return msgs
}

// extractTextFromContent pulls text from content block arrays.
func extractTextFromContent(blocks []json.RawMessage) string {
	var parts []string
	for _, block := range blocks {
		var b struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
			Name     string `json:"name"`
		}
		if err := json.Unmarshal(block, &b); err != nil {
			continue
		}
		switch b.Type {
		case "text":
			if b.Text != "" {
				parts = append(parts, b.Text)
			}
		case "thinking":
			if b.Thinking != "" {
				parts = append(parts, fmt.Sprintf("[thinking] %s", b.Thinking))
			}
		case "tool_use":
			parts = append(parts, fmt.Sprintf("[tool: %s]", b.Name))
		}
	}
	return strings.Join(parts, "\n")
}
