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

		// Set up event handlers that produce tea.Msg via a channel.
		// Use a generous buffer and block instead of dropping ordering-critical events.
		msgCh := make(chan tea.Msg, 1024)

		client.On("event", func(data json.RawMessage) {
			enqueueRelayMsg(msgCh, parseRelayJSON(data))
		})

		// Handle session state from the relay (events arrive wrapped in a session event)
		client.On("session_event", func(data json.RawMessage) {
			// The relay may deliver events wrapped as {"sessionId":"...", "event":{...}}
			var wrapper struct {
				Event json.RawMessage `json:"event"`
			}
			if json.Unmarshal(data, &wrapper) == nil && len(wrapper.Event) > 0 {
				enqueueRelayMsg(msgCh, parseRelayJSON(wrapper.Event))
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

func enqueueRelayMsg(ch chan tea.Msg, msg tea.Msg) {
	if ch == nil || msg == nil {
		return
	}
	ch <- msg
}

func parseFinalMessageUpdate(raw json.RawMessage) (MessageUpdateMsg, bool) {
	var mu MessageUpdateMsg
	if len(raw) == 0 {
		return mu, false
	}
	if json.Unmarshal(raw, &mu) != nil {
		return mu, false
	}
	var idObj struct {
		ID string `json:"id"`
	}
	if mu.MessageID == "" && json.Unmarshal(raw, &idObj) == nil {
		mu.MessageID = idObj.ID
	}
	return mu, true
}

// parseRelayJSON converts a raw JSON relay event into a typed tea.Msg.
// Used by both the "event" and "session_event" handlers.
func parseRelayJSON(data json.RawMessage) tea.Msg {
	var wrapper struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &wrapper); err != nil {
		return nil
	}

	switch wrapper.Type {
	case "heartbeat":
		var hb HeartbeatMsg
		if json.Unmarshal(data, &hb) == nil {
			return hb
		}
	case "session_active":
		var sa SessionActiveMsg
		if json.Unmarshal(data, &sa) == nil {
			return sa
		}
	case "message_update":
		// Check for streaming delta (assistantMessageEvent) vs final (message)
		var raw struct {
			AssistantMessageEvent json.RawMessage `json:"assistantMessageEvent"`
			Message               json.RawMessage `json:"message"`
		}
		if json.Unmarshal(data, &raw) == nil && len(raw.AssistantMessageEvent) > 0 {
			// Streaming delta — parse assistantMessageEvent
			var ame map[string]any
			if json.Unmarshal(raw.AssistantMessageEvent, &ame) == nil {
				return parseStreamingDeltaFromMap(ame)
			}
		}
		// Final message update lives under the nested "message" object.
		if json.Unmarshal(data, &raw) == nil {
			if mu, ok := parseFinalMessageUpdate(raw.Message); ok {
				return mu
			}
		}
	case "message_start":
		var raw struct {
			Message struct {
				ID   string `json:"id"`
				Role string `json:"role"`
			} `json:"message"`
		}
		if json.Unmarshal(data, &raw) == nil {
			return MessageStartMsg{MessageID: raw.Message.ID, Role: raw.Message.Role}
		}
	case "message_end":
		// Extract message for upsert (same shape as final message_update)
		var raw struct {
			Message json.RawMessage `json:"message"`
		}
		if json.Unmarshal(data, &raw) == nil && len(raw.Message) > 0 {
			if mu, ok := parseFinalMessageUpdate(raw.Message); ok {
				return mu
			}
		}
	case "tool_result_message":
		var tr ToolResultMsg
		if json.Unmarshal(data, &tr) == nil {
			return tr
		}
	case "tool_execution_start":
		var tes ToolExecutionStartMsg
		if json.Unmarshal(data, &tes) == nil {
			return tes
		}
	case "tool_execution_end":
		var tee ToolExecutionEndMsg
		if json.Unmarshal(data, &tee) == nil {
			return tee
		}
	case "session_metadata_update":
		var sm SessionMetadataMsg
		if json.Unmarshal(data, &sm) == nil {
			return sm
		}
	default:
		return RelayEventMsg{Type: wrapper.Type, Data: data}
	}
	return nil
}

// parseStreamingDeltaFromMap creates a StreamingDeltaMsg from a parsed
// assistantMessageEvent map. Used by the relay JSON parser.
func parseStreamingDeltaFromMap(ame map[string]any) tea.Msg {
	sd := StreamingDeltaMsg{Role: "assistant"}
	sd.DeltaType, _ = ame["type"].(string)
	sd.Delta, _ = ame["delta"].(string)

	if partial, ok := ame["partial"].(map[string]any); ok {
		sd.MessageID, _ = partial["id"].(string)
		if role, ok := partial["role"].(string); ok && role != "" {
			sd.Role = role
		}
		if sd.MessageID == "" {
			sd.MessageID = "streaming_partial"
		}
		// Content comes as []any from json.Unmarshal into map[string]any
		if content, ok := partial["content"].([]any); ok {
			for _, block := range content {
				if b, err := json.Marshal(block); err == nil {
					sd.Content = append(sd.Content, json.RawMessage(b))
				}
			}
		}
	}
	return sd
}
