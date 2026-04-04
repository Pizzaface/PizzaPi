package tui

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// tickMsg is sent by the animation ticker.
type tickMsg time.Time

// tickInterval is how often the animation ticker fires.
const tickInterval = 200 * time.Millisecond

func doTick() tea.Cmd {
	return tea.Tick(tickInterval, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func reconnectDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	d := time.Second
	for i := 1; i < attempt; i++ {
		d *= 2
		if d >= 8*time.Second {
			return 8 * time.Second
		}
	}
	return d
}

func scheduleReconnect(attempt int) tea.Cmd {
	delay := reconnectDelay(attempt)
	return tea.Tick(delay, func(time.Time) tea.Msg {
		return RelayReconnectMsg{Attempt: attempt}
	})
}

func update(a App, msg tea.Msg) (tea.Model, tea.Cmd) {
	s := a.state
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.Width = msg.Width
		s.Height = msg.Height
		// Resize input to match
		s.Input.SetWidth(msg.Width - 4) // leave room for prompt prefix

	case tickMsg:
		s.TickCount++
		// Keep ticking while streaming
		if s.IsStreaming || s.Active {
			cmds = append(cmds, doTick())
		}

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			return a, tea.Quit

		case "esc":
			s.Input.Reset()

		case "enter":
			text := strings.TrimSpace(s.Input.Value())
			if text != "" {
				s.Messages = append(s.Messages, DisplayMessage{
					Role: "user",
					Text: text,
				})
				s.Input.Reset()
				s.ScrollOffset = 0

				// Save to prompt history
				s.PromptHistory = append(s.PromptHistory, text)
				s.HistoryIndex = -1

				// Send via session controller
				if s.Session != nil {
					if cmd := s.Session.SendMessage(text); cmd != nil {
						cmds = append(cmds, cmd)
					}
				}
			}
			a.state = s
			return a, tea.Batch(cmds...)

		case "ctrl+u", "pgup":
			s.ScrollOffset += 10
			maxScroll := len(s.Messages) * 3 // rough estimate
			if s.ScrollOffset > maxScroll {
				s.ScrollOffset = maxScroll
			}
			a.state = s
			return a, nil

		case "ctrl+d", "pgdown":
			s.ScrollOffset -= 10
			if s.ScrollOffset < 0 {
				s.ScrollOffset = 0
			}
			a.state = s
			return a, nil
		}

	// --- Connection events ---
	case RelayConnectedMsg:
		s.Connected = true
		s.IsReconnecting = false
		s.ReconnectAttempts = 0
		if ls, ok := s.Session.(*LocalSession); ok {
			cmds = append(cmds, listenLocal(ls))
		} else {
			cmds = append(cmds, listenRelay())
		}
		// Start animation ticker
		cmds = append(cmds, doTick())

	case RelayDisconnectedMsg:
		s.Connected = false
		s.Active = false
		s.IsStreaming = false
		s.StreamingMessageID = ""
		s.ThinkingStart = time.Time{}
		clear(s.ActiveTools)
		if s.Mode == "relay" && s.Session != nil && !s.IsReconnecting {
			s.IsReconnecting = true
			s.ReconnectAttempts = 1
			cmds = append(cmds, scheduleReconnect(s.ReconnectAttempts))
		}

	case RelayReconnectMsg:
		if s.Mode == "relay" && s.Session != nil && !s.Connected {
			s.IsReconnecting = true
			if msg.Attempt > s.ReconnectAttempts {
				s.ReconnectAttempts = msg.Attempt
			}
			if cmd := s.Session.Start(""); cmd != nil {
				cmds = append(cmds, cmd)
			}
		}

	case RelayErrorMsg:
		s.Messages = append(s.Messages, DisplayMessage{
			Role: "system",
			Text: fmt.Sprintf("⚠ %v", msg.Err),
		})
		if s.Mode == "relay" && s.Session != nil && !s.Connected {
			s.IsReconnecting = true
			s.ReconnectAttempts++
			if s.ReconnectAttempts < 1 {
				s.ReconnectAttempts = 1
			}
			cmds = append(cmds, scheduleReconnect(s.ReconnectAttempts))
		}

	// --- Session events ---
	case HeartbeatMsg:
		wasActive := s.Active
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
		// Detect transition to idle
		if wasActive && !msg.Active {
			s.IsStreaming = false
			s.StreamingMessageID = ""
			s.ThinkingStart = time.Time{}
			clear(s.ActiveTools)
		}

	case SessionActiveMsg:
		incoming := parseMessages(msg.State.Messages)
		s.Messages = mergeSnapshotMessages(s.Messages, incoming)
		if msg.State.Model != nil && msg.State.Model.ID != "" {
			s.ModelID = msg.State.Model.ID
		}
		if msg.State.Cwd != "" {
			s.Cwd = msg.State.Cwd
		}
		s.ScrollOffset = 0

	case StreamingDeltaMsg:
		text := extractTextFromContent(msg.Content)
		s.StreamingMessageID = msg.MessageID
		s.IsStreaming = true
		found := false
		for i := range s.Messages {
			if s.Messages[i].ID == msg.MessageID {
				s.Messages[i].Text = text
				s.Messages[i].Role = msg.Role
				found = true
				break
			}
		}
		if !found && text != "" {
			s.Messages = append(s.Messages, DisplayMessage{
				ID:   msg.MessageID,
				Role: msg.Role,
				Text: text,
			})
		}
		// Start thinking timer on first thinking delta
		if msg.DeltaType == "thinking_delta" && s.ThinkingStart.IsZero() {
			s.ThinkingStart = time.Now()
		}

	case MessageStartMsg:
		s.StreamingMessageID = msg.MessageID
		s.IsStreaming = true
		s.ThinkingStart = time.Time{} // reset thinking timer
		if msg.MessageID != "" {
			found := false
			for _, m := range s.Messages {
				if m.ID == msg.MessageID {
					found = true
					break
				}
			}
			if !found {
				s.Messages = append(s.Messages, DisplayMessage{
					ID:   msg.MessageID,
					Role: msg.Role,
					Text: "", // empty — cursor animation will show
				})
			}
		}

	case MessageUpdateMsg:
		text := extractTextFromContent(msg.Content)
		toolOnly := isToolOnlyContent(msg.Content)
		s.StreamingMessageID = ""
		s.IsStreaming = false
		s.ThinkingStart = time.Time{}
		found := false
		for i := range s.Messages {
			if s.Messages[i].ID == msg.MessageID {
				// Tool-use-only updates are advisory and should not clobber already-streamed
				// assistant text. Tool state/result rendering is handled separately.
				if !(toolOnly && s.Messages[i].Text != "") {
					s.Messages[i].Text = text
				}
				if msg.Role != "" {
					s.Messages[i].Role = msg.Role
				}
				if msg.Timestamp != 0 {
					s.Messages[i].Timestamp = msg.Timestamp
				}
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

	case ToolExecutionStartMsg:
		s.ActiveTools[msg.ToolCallID] = msg.ToolName

	case ToolExecutionEndMsg:
		delete(s.ActiveTools, msg.ToolCallID)

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
	}

	// After handling session events, keep listening for the next one.
	switch msg.(type) {
	case HeartbeatMsg, SessionActiveMsg, MessageUpdateMsg, ToolResultMsg,
		SessionMetadataMsg, RelayEventMsg,
		StreamingDeltaMsg, MessageStartMsg, ToolExecutionStartMsg, ToolExecutionEndMsg:
		if ls, ok := s.Session.(*LocalSession); ok {
			cmds = append(cmds, listenLocal(ls))
		} else {
			cmds = append(cmds, listenRelay())
		}
	}

	// Forward key messages to the text input
	if _, ok := msg.(tea.KeyMsg); ok {
		var cmd tea.Cmd
		s.Input, cmd = s.Input.Update(msg)
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
	}

	a.state = s
	return a, tea.Batch(cmds...)
}

// parseMessages converts raw JSON messages from a session_active snapshot.
func parseMessages(raw []json.RawMessage) []DisplayMessage {
	var msgs []DisplayMessage
	for _, r := range raw {
		var m struct {
			Role      string          `json:"role"`
			Content   json.RawMessage `json:"content"`
			MessageID string          `json:"messageId"`
			ID        string          `json:"id"`
			ToolName  string          `json:"toolName"`
			IsError   bool            `json:"isError"`
			Timestamp int64           `json:"timestamp"`
		}
		if err := json.Unmarshal(r, &m); err != nil {
			continue
		}

		id := m.MessageID
		if id == "" {
			id = m.ID
		}
		dm := DisplayMessage{
			ID:        id,
			Role:      m.Role,
			Timestamp: m.Timestamp,
		}

		if m.Role == "tool_result" {
			dm.ToolName = m.ToolName
			dm.IsError = m.IsError
			var text string
			if err := json.Unmarshal(m.Content, &text); err == nil {
				dm.Text = text
			} else {
				dm.Text = string(m.Content)
			}
			if len(dm.Text) > 500 {
				dm.Text = dm.Text[:497] + "..."
			}
		} else {
			var blocks []json.RawMessage
			if err := json.Unmarshal(m.Content, &blocks); err == nil {
				dm.Text = extractTextFromContent(blocks)
			} else {
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

func mergeSnapshotMessages(current, incoming []DisplayMessage) []DisplayMessage {
	if len(current) == 0 {
		return incoming
	}

	incomingUserCounts := map[string]int{}
	for _, m := range incoming {
		if m.Role == "user" {
			incomingUserCounts[m.Text]++
		}
	}

	merged := append([]DisplayMessage{}, incoming...)
	for _, m := range current {
		if m.Role != "user" || m.ID != "" {
			continue
		}
		// If the snapshot now contains this user message, treat it as reconciled.
		if incomingUserCounts[m.Text] > 0 {
			incomingUserCounts[m.Text]--
			continue
		}
		merged = append(merged, m)
	}
	return merged
}

func isToolOnlyContent(blocks []json.RawMessage) bool {
	if len(blocks) == 0 {
		return false
	}
	foundTool := false
	for _, block := range blocks {
		var b struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(block, &b); err != nil {
			return false
		}
		switch b.Type {
		case "tool_use":
			foundTool = true
		case "text", "thinking":
			return false
		default:
			return false
		}
	}
	return foundTool
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
