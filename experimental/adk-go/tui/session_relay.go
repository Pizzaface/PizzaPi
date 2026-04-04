package tui

import tea "github.com/charmbracelet/bubbletea"

// RemoteSession implements SessionController by connecting to a PizzaPi relay.
// It reuses the existing relay connection code from relay.go.
type RemoteSession struct {
	relayURL  string
	apiKey    string
	sessionID string
}

// NewRemoteSession creates a session controller that connects to a relay.
func NewRemoteSession(relayURL, apiKey, sessionID string) *RemoteSession {
	return &RemoteSession{
		relayURL:  relayURL,
		apiKey:    apiKey,
		sessionID: sessionID,
	}
}

func (s *RemoteSession) Mode() string { return "relay" }

// Start connects to the relay and joins the session.
func (s *RemoteSession) Start(prompt string) tea.Cmd {
	// If a prompt is provided for a relay session, we'd need to create a new
	// session via the relay. For now, we just connect as a viewer.
	return connectToRelay(s.relayURL, s.apiKey, s.sessionID)
}

// SendMessage sends input to the relay session.
func (s *RemoteSession) SendMessage(text string) tea.Cmd {
	return sendRelayInput(text)
}

// Stop disconnects from the relay.
func (s *RemoteSession) Stop() {
	client := getRelayClient()
	if client != nil {
		client.Close()
	}
}
