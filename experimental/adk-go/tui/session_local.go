package tui

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sync"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/runner"
)

// LocalSession implements SessionController by embedding a Provider directly.
// No relay needed — the provider runs in-process and events are converted
// to tea.Msg values inline.
type LocalSession struct {
	provider runner.Provider
	cwd      string
	model    string
	logger   *log.Logger

	eventCh chan tea.Msg // pumps provider events as tea.Msg
	mu      sync.Mutex
	started bool
}

// NewLocalSession creates a session controller that runs a provider locally.
func NewLocalSession(provider runner.Provider, cwd, model string) *LocalSession {
	return &LocalSession{
		provider: provider,
		cwd:      cwd,
		model:    model,
		logger:   log.New(os.Stderr, "[local] ", log.LstdFlags|log.Lmsgprefix),
		eventCh:  make(chan tea.Msg, 64),
	}
}

func (s *LocalSession) Mode() string { return "local" }

// Start launches the provider and returns a tea.Cmd that produces the first
// event. Subsequent events arrive via listenLocal().
func (s *LocalSession) Start(prompt string) tea.Cmd {
	return func() tea.Msg {
		s.mu.Lock()
		if s.started {
			s.mu.Unlock()
			return RelayErrorMsg{Err: fmt.Errorf("session already started")}
		}
		s.started = true
		s.mu.Unlock()

		homeDir, _ := os.UserHomeDir()

		pctx := runner.ProviderContext{
			Prompt:  prompt,
			Cwd:     s.cwd,
			Model:   s.model,
			HomeDir: homeDir,
			OnStderr: func(line string) {
				s.logger.Printf("[stderr] %s", line)
			},
		}

		relayEvents, err := s.provider.Start(pctx)
		if err != nil {
			return RelayErrorMsg{Err: fmt.Errorf("start provider: %w", err)}
		}

		// Bridge goroutine: convert RelayEvents to tea.Msg and pump to eventCh.
		go s.pump(relayEvents)

		return RelayConnectedMsg{}
	}
}

// pump reads RelayEvents from the provider and converts them to typed tea.Msg.
func (s *LocalSession) pump(events <-chan runner.RelayEvent) {
	defer func() {
		select {
		case s.eventCh <- RelayDisconnectedMsg{Reason: "provider exited"}:
		default:
		}
		close(s.eventCh)
	}()

	for ev := range events {
		msg := relayEventToMsg(ev)
		if msg != nil {
			s.eventCh <- msg
		}
	}
}

// relayEventToMsg converts a RelayEvent map to a typed tea.Msg.
func relayEventToMsg(ev runner.RelayEvent) tea.Msg {
	evType, _ := ev["type"].(string)

	switch evType {
	case "heartbeat":
		var hb HeartbeatMsg
		if b, err := json.Marshal(ev); err == nil {
			json.Unmarshal(b, &hb)
		}
		return hb

	case "session_active":
		var sa SessionActiveMsg
		if b, err := json.Marshal(ev); err == nil {
			json.Unmarshal(b, &sa)
		}
		return sa

	case "message_update":
		// Check for streaming delta (assistantMessageEvent) vs final (message)
		if ameRaw, hasAME := ev["assistantMessageEvent"]; hasAME {
			return parseStreamingDelta(ameRaw)
		}
		// Final message update — has "message" field
		var mu MessageUpdateMsg
		if msg, ok := ev["message"].(map[string]any); ok {
			if b, err := json.Marshal(msg); err == nil {
				json.Unmarshal(b, &mu)
			}
		}
		return mu

	case "message_start":
		var ms MessageStartMsg
		if msg, ok := ev["message"].(map[string]any); ok {
			ms.Role, _ = msg["role"].(string)
			ms.MessageID, _ = msg["id"].(string)
		}
		return ms

	case "message_end":
		// Extract the message for upsert (same as final message_update)
		var mu MessageUpdateMsg
		if msg, ok := ev["message"].(map[string]any); ok {
			if b, err := json.Marshal(msg); err == nil {
				json.Unmarshal(b, &mu)
			}
		}
		return mu

	case "tool_result_message":
		var tr ToolResultMsg
		if b, err := json.Marshal(ev); err == nil {
			json.Unmarshal(b, &tr)
		}
		return tr

	case "tool_execution_start":
		var tes ToolExecutionStartMsg
		if b, err := json.Marshal(ev); err == nil {
			json.Unmarshal(b, &tes)
		}
		return tes

	case "tool_execution_end":
		var tee ToolExecutionEndMsg
		if b, err := json.Marshal(ev); err == nil {
			json.Unmarshal(b, &tee)
		}
		return tee

	case "session_metadata_update":
		var sm SessionMetadataMsg
		if b, err := json.Marshal(ev); err == nil {
			json.Unmarshal(b, &sm)
		}
		return sm

	default:
		return RelayEventMsg{Type: evType, Data: mustMarshal(ev)}
	}
}

// parseStreamingDelta extracts a StreamingDeltaMsg from an assistantMessageEvent.
// The ameRaw is the value of the "assistantMessageEvent" key in the relay event.
func parseStreamingDelta(ameRaw any) tea.Msg {
	ameMap, ok := ameRaw.(map[string]any)
	if !ok {
		return nil
	}

	sd := StreamingDeltaMsg{
		Role: "assistant",
	}

	// Extract delta type and text
	sd.DeltaType, _ = ameMap["type"].(string)
	sd.Delta, _ = ameMap["delta"].(string)

	// Extract the partial message (accumulated content blocks + ID)
	if partial, ok := ameMap["partial"].(map[string]any); ok {
		sd.MessageID, _ = partial["id"].(string)
		sd.Role, _ = partial["role"].(string)
		if sd.Role == "" {
			sd.Role = "assistant"
		}
		// Convert content to []json.RawMessage
		if content, ok := partial["content"].([]any); ok {
			for _, block := range content {
				if b, err := json.Marshal(block); err == nil {
					sd.Content = append(sd.Content, json.RawMessage(b))
				}
			}
		} else if contentMaps, ok := partial["content"].([]map[string]any); ok {
			for _, block := range contentMaps {
				if b, err := json.Marshal(block); err == nil {
					sd.Content = append(sd.Content, json.RawMessage(b))
				}
			}
		}
	}

	return sd
}

func mustMarshal(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

// SendMessage sends a follow-up to the provider.
func (s *LocalSession) SendMessage(text string) tea.Cmd {
	return func() tea.Msg {
		if err := s.provider.SendMessage(text); err != nil {
			return RelayErrorMsg{Err: fmt.Errorf("send message: %w", err)}
		}
		return nil
	}
}

// Stop terminates the provider.
func (s *LocalSession) Stop() {
	s.provider.Stop()
}

// listenLocal returns a tea.Cmd that waits for the next event from the local provider.
func listenLocal(s *LocalSession) tea.Cmd {
	return func() tea.Msg {
		msg, ok := <-s.eventCh
		if !ok {
			return RelayDisconnectedMsg{Reason: "channel closed"}
		}
		return msg
	}
}
