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
		if _, hasAME := ev["assistantMessageEvent"]; hasAME {
			// Streaming delta — pass through as generic event for now
			// The TUI model can be updated to handle this more granularly
			return RelayEventMsg{Type: evType, Data: mustMarshal(ev)}
		}
		// Final message update
		var mu MessageUpdateMsg
		if msg, ok := ev["message"].(map[string]any); ok {
			if b, err := json.Marshal(msg); err == nil {
				json.Unmarshal(b, &mu)
			}
		}
		return mu

	case "message_start":
		return RelayEventMsg{Type: evType, Data: mustMarshal(ev)}

	case "message_end":
		// Extract the message for upsert
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

	case "tool_execution_start", "tool_execution_end":
		return RelayEventMsg{Type: evType, Data: mustMarshal(ev)}

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
