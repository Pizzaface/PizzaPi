package main

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"
)

// RelaySession manages a per-session Socket.IO connection to the /relay
// namespace. This mimics what the Bun worker does: connect to /relay,
// send "register" with the sessionId, and forward events as the session.
//
// In the Bun architecture, each worker is its own process that connects
// independently to the relay. The Go runner emulates this by creating a
// lightweight SIO connection per session on /relay.
type RelaySession struct {
	sessionID   string
	token       string // auth token returned by relay registration
	client      *SIOClient
	logger      *log.Logger
	onInput     func(text string)          // callback when user sends input from web UI
	onSteer     func(text string)          // callback for steer (interrupt) messages
	onFollowUp  func(text string)          // callback for follow-up (post-turn) messages
	done        chan struct{}
	closeOnce   sync.Once
}

// NewRelaySession creates and connects a relay session.
func NewRelaySession(relayURL, apiKey, sessionID, cwd string, logger *log.Logger) *RelaySession {
	rs := &RelaySession{
		sessionID: sessionID,
		done:      make(chan struct{}),
		logger:    logger,
	}
	return rs
}

// Connect establishes the /relay connection and registers the session.
func (rs *RelaySession) Connect(relayURL, apiKey, cwd string) error {
	registered := make(chan struct{}, 1)

	rs.client = NewSIOClient(SIOClientConfig{
		URL:       relayURL,
		Namespace: "/relay",
		Auth: map[string]any{
			"apiKey": apiKey,
		},
		Logger: rs.logger,
		OnConnect: func() {
			rs.logger.Printf("session %s: relay /relay connected, registering", rs.sessionID[:8])
			rs.client.Emit("register", map[string]any{
				"sessionId":  rs.sessionID,
				"cwd":        cwd,
				"ephemeral":  false,
				"collabMode": true,
			})
		},
	})

	rs.client.On("registered", func(data json.RawMessage) {
		var payload struct {
			SessionID string `json:"sessionId"`
			Token     string `json:"token"`
			ShareURL  string `json:"shareUrl"`
		}
		if err := json.Unmarshal(data, &payload); err == nil {
			rs.token = payload.Token
			rs.logger.Printf("session %s: relay session registered (shareUrl=%s)", rs.sessionID[:8], payload.ShareURL)
		} else {
			rs.logger.Printf("session %s: relay session registered (token parse error: %v)", rs.sessionID[:8], err)
		}
		select {
		case registered <- struct{}{}:
		default:
		}
	})

	rs.client.On("error", func(data json.RawMessage) {
		rs.logger.Printf("session %s: relay error: %s", rs.sessionID[:8], string(data))
	})

	rs.client.On("exec", func(data json.RawMessage) {
		rs.logger.Printf("session %s: received exec: %s", rs.sessionID[:8], string(data))
	})

	// Handle user input from the web UI (collab mode)
	rs.client.On("input", func(data json.RawMessage) {
		var payload struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(data, &payload); err != nil {
			rs.logger.Printf("session %s: failed to parse input: %v", rs.sessionID[:8], err)
			return
		}
		rs.logger.Printf("session %s: received user input: %s", rs.sessionID[:8], payload.Text[:min(len(payload.Text), 80)])
		if rs.onInput != nil {
			rs.onInput(payload.Text)
		}
	})

	// Handle steer (mid-turn interrupt) messages from the relay
	rs.client.On("steer", func(data json.RawMessage) {
		var payload struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(data, &payload); err != nil {
			rs.logger.Printf("session %s: failed to parse steer: %v", rs.sessionID[:8], err)
			return
		}
		rs.logger.Printf("session %s: received steer: %s", rs.sessionID[:8], payload.Text[:min(len(payload.Text), 80)])
		if rs.onSteer != nil {
			rs.onSteer(payload.Text)
		}
	})

	// Handle follow-up (post-turn queued) messages from the relay
	rs.client.On("follow_up", func(data json.RawMessage) {
		var payload struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(data, &payload); err != nil {
			rs.logger.Printf("session %s: failed to parse follow_up: %v", rs.sessionID[:8], err)
			return
		}
		rs.logger.Printf("session %s: received follow_up: %s", rs.sessionID[:8], payload.Text[:min(len(payload.Text), 80)])
		if rs.onFollowUp != nil {
			rs.onFollowUp(payload.Text)
		}
	})

	if err := rs.client.Connect(); err != nil {
		return fmt.Errorf("connect to /relay: %w", err)
	}

	select {
	case <-registered:
		return nil
	case <-time.After(10 * time.Second):
		rs.client.Close()
		return fmt.Errorf("timeout waiting for relay session registration")
	}
}

// EmitEvent sends a session event through the /relay connection.
func (rs *RelaySession) EmitEvent(event map[string]any) error {
	return rs.client.Emit("event", map[string]any{
		"token": rs.token,
		"event": event,
	})
}

// Close disconnects the relay session.
func (rs *RelaySession) Close() {
	rs.closeOnce.Do(func() {
		close(rs.done)
		rs.client.Close()
	})
}

// Done returns a channel that closes when the session is done.
func (rs *RelaySession) Done() <-chan struct{} {
	return rs.done
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
