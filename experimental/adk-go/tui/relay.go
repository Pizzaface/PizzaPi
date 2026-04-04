package tui

import (
	"encoding/json"
	"log"
	"sync"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/relay"
)

// relayConn holds the active relay connection so we can send input back.
var (
	relayClient   *relay.Client
	relayClientMu sync.Mutex
)

// connectToRelay returns a tea.Cmd that establishes a Socket.IO connection
// to the relay and subscribes to session events. Events are converted to
// typed tea.Msg values and delivered to the TUI update loop.
func connectToRelay(relayURL, apiKey, sessionID string) tea.Cmd {
	return func() tea.Msg {
		logger := log.Default()

		client := relay.NewClient(relay.ClientConfig{
			URL:       relayURL,
			Namespace: "/relay",
			Auth: map[string]any{
				"apiKey": apiKey,
			},
			Logger: logger,
			OnConnect: func() {
				logger.Printf("[tui] relay connected")
				// Join the session as a viewer
				if sessionID != "" {
					client := getRelayClient()
					if client != nil {
						client.Emit("join_session", map[string]any{
							"sessionId": sessionID,
						})
					}
				}
			},
		})

		// Store client for input sending
		setRelayClient(client)

		// Set up event handlers that produce tea.Msg via a channel
		msgCh := make(chan tea.Msg, 64)

		client.On("event", func(data json.RawMessage) {
			// Relay events arrive as {"type":"...", ...}
			var wrapper struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(data, &wrapper); err != nil {
				return
			}

			var msg tea.Msg
			switch wrapper.Type {
			case "heartbeat":
				var hb HeartbeatMsg
				if json.Unmarshal(data, &hb) == nil {
					msg = hb
				}
			case "session_active":
				var sa SessionActiveMsg
				if json.Unmarshal(data, &sa) == nil {
					msg = sa
				}
			case "message_update":
				var mu MessageUpdateMsg
				if json.Unmarshal(data, &mu) == nil {
					msg = mu
				}
			case "tool_result_message":
				var tr ToolResultMsg
				if json.Unmarshal(data, &tr) == nil {
					msg = tr
				}
			case "session_metadata_update":
				var sm SessionMetadataMsg
				if json.Unmarshal(data, &sm) == nil {
					msg = sm
				}
			default:
				msg = RelayEventMsg{Type: wrapper.Type, Data: data}
			}

			if msg != nil {
				select {
				case msgCh <- msg:
				default:
					// Channel full, drop event
				}
			}
		})

		// Handle session state from the relay (events arrive wrapped in a session event)
		client.On("session_event", func(data json.RawMessage) {
			// The relay may deliver events wrapped as {"sessionId":"...", "event":{...}}
			var wrapper struct {
				Event json.RawMessage `json:"event"`
			}
			if json.Unmarshal(data, &wrapper) == nil && len(wrapper.Event) > 0 {
				// Re-dispatch as the inner event
				var inner struct {
					Type string `json:"type"`
				}
				if json.Unmarshal(wrapper.Event, &inner) == nil {
					var msg tea.Msg
					switch inner.Type {
					case "heartbeat":
						var hb HeartbeatMsg
						if json.Unmarshal(wrapper.Event, &hb) == nil {
							msg = hb
						}
					case "session_active":
						var sa SessionActiveMsg
						if json.Unmarshal(wrapper.Event, &sa) == nil {
							msg = sa
						}
					case "message_update":
						var mu MessageUpdateMsg
						if json.Unmarshal(wrapper.Event, &mu) == nil {
							msg = mu
						}
					case "tool_result_message":
						var tr ToolResultMsg
						if json.Unmarshal(wrapper.Event, &tr) == nil {
							msg = tr
						}
					case "session_metadata_update":
						var sm SessionMetadataMsg
						if json.Unmarshal(wrapper.Event, &sm) == nil {
							msg = sm
						}
					}
					if msg != nil {
						select {
						case msgCh <- msg:
						default:
						}
					}
				}
			}
		})

		if err := client.Connect(); err != nil {
			return RelayErrorMsg{Err: err}
		}

		// Start a goroutine to pump messages from the channel into the tea.Program.
		// We return the first message synchronously (RelayConnectedMsg), then
		// subsequent messages arrive via the listen command.
		go func() {
			<-client.Done()
			select {
			case msgCh <- RelayDisconnectedMsg{Reason: "connection closed"}:
			default:
			}
		}()

		// Store the channel for the listen command
		setRelayChan(msgCh)

		return RelayConnectedMsg{}
	}
}

// listenRelay returns a tea.Cmd that waits for the next relay event.
// This is called repeatedly by the update loop after receiving a relay message.
func listenRelay() tea.Cmd {
	return func() tea.Msg {
		ch := getRelayChan()
		if ch == nil {
			return nil
		}
		msg, ok := <-ch
		if !ok {
			return RelayDisconnectedMsg{Reason: "channel closed"}
		}
		return msg
	}
}

// sendRelayInput returns a tea.Cmd that sends user input to the relay.
func sendRelayInput(text string) tea.Cmd {
	return func() tea.Msg {
		client := getRelayClient()
		if client == nil {
			return nil
		}
		client.Emit("input", map[string]any{
			"text": text,
		})
		return nil
	}
}

// Thread-safe relay state
var (
	relayChan   chan tea.Msg
	relayChanMu sync.Mutex
)

func setRelayClient(c *relay.Client) {
	relayClientMu.Lock()
	relayClient = c
	relayClientMu.Unlock()
}

func getRelayClient() *relay.Client {
	relayClientMu.Lock()
	defer relayClientMu.Unlock()
	return relayClient
}

func setRelayChan(ch chan tea.Msg) {
	relayChanMu.Lock()
	relayChan = ch
	relayChanMu.Unlock()
}

func getRelayChan() chan tea.Msg {
	relayChanMu.Lock()
	defer relayChanMu.Unlock()
	return relayChan
}
