// Package relay provides a minimal Socket.IO v4 client for the PizzaPi relay.
//
// Engine.IO v4 over WebSocket:
//   - Handshake: GET /socket.io/?EIO=4&transport=websocket → upgrade to WS
//   - Packet types: 0=open, 1=close, 2=ping, 3=pong, 4=message, 5=upgrade, 6=noop
//
// Socket.IO v4 on top of Engine.IO messages (type 4):
//   - Packet types: 0=CONNECT, 1=DISCONNECT, 2=EVENT, 3=ACK, 4=CONNECT_ERROR, 5=BINARY_EVENT, 6=BINARY_ACK
//   - Namespace prefix: "/<ns>," or "/" (default)
//
// Example event: 42/runner,["event_name",{...}]
package relay

import (
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Client is a minimal Socket.IO v4 client for the PizzaPi relay.
type Client struct {
	url       string
	namespace string
	auth      map[string]any

	conn   *websocket.Conn
	connMu sync.Mutex

	handlers   map[string][]func(json.RawMessage)
	handlersMu sync.RWMutex

	pingInterval time.Duration
	pingTimeout  time.Duration

	done     chan struct{}
	lastPing chan struct{} // signaled each time server sends EIO ping
	closed   atomic.Bool
	logger   *log.Logger

	onConnect    func()
	onDisconnect func(reason string)
}

// ClientConfig configures a new Client.
type ClientConfig struct {
	// URL is the relay base URL (e.g. "http://localhost:7492")
	URL string
	// Namespace is the Socket.IO namespace (e.g. "/runner")
	Namespace string
	// Auth is the handshake auth payload
	Auth map[string]any
	// Logger for debug output (nil = default logger)
	Logger *log.Logger

	OnConnect    func()
	OnDisconnect func(reason string)
}

// NewClient creates a new Socket.IO client. Call Connect() to establish the connection.
func NewClient(cfg ClientConfig) *Client {
	if cfg.Logger == nil {
		cfg.Logger = log.Default()
	}
	if cfg.Namespace == "" {
		cfg.Namespace = "/"
	}
	return &Client{
		url:          cfg.URL,
		namespace:    cfg.Namespace,
		auth:         cfg.Auth,
		handlers:     make(map[string][]func(json.RawMessage)),
		logger:       cfg.Logger,
		onConnect:    cfg.OnConnect,
		onDisconnect: cfg.OnDisconnect,
	}
}

// On registers an event handler.
func (c *Client) On(event string, handler func(json.RawMessage)) {
	c.handlersMu.Lock()
	defer c.handlersMu.Unlock()
	c.handlers[event] = append(c.handlers[event], handler)
}

// Emit sends a Socket.IO event to the server.
func (c *Client) Emit(event string, data any) error {
	payload, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshal data: %w", err)
	}

	// Socket.IO EVENT packet: 42/namespace,["event_name",<data>]
	var msg string
	if c.namespace == "/" {
		msg = fmt.Sprintf(`42[%q,%s]`, event, payload)
	} else {
		msg = fmt.Sprintf(`42%s,[%q,%s]`, c.namespace, event, payload)
	}

	c.connMu.Lock()
	defer c.connMu.Unlock()
	if c.conn == nil {
		return fmt.Errorf("not connected")
	}
	return c.conn.WriteMessage(websocket.TextMessage, []byte(msg))
}

// Connect establishes the WebSocket connection and performs the Engine.IO + Socket.IO handshake.
func (c *Client) Connect() error {
	// Build the WebSocket URL from the HTTP URL
	wsURL, err := c.buildWSURL()
	if err != nil {
		return fmt.Errorf("build WS URL: %w", err)
	}

	c.logger.Printf("[sio] connecting to %s", wsURL)

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		return fmt.Errorf("websocket dial: %w", err)
	}

	c.connMu.Lock()
	c.conn = conn
	c.connMu.Unlock()

	c.done = make(chan struct{})
	c.lastPing = make(chan struct{}, 1)

	// Read the Engine.IO open packet (type 0)
	_, msg, err := conn.ReadMessage()
	if err != nil {
		conn.Close()
		return fmt.Errorf("read open packet: %w", err)
	}

	if len(msg) == 0 || msg[0] != '0' {
		conn.Close()
		return fmt.Errorf("expected Engine.IO open packet, got: %s", string(msg))
	}

	// Parse the open payload: {"sid":"...","upgrades":[],"pingInterval":25000,"pingTimeout":20000}
	var openPayload struct {
		SID          string `json:"sid"`
		PingInterval int    `json:"pingInterval"`
		PingTimeout  int    `json:"pingTimeout"`
	}
	if err := json.Unmarshal(msg[1:], &openPayload); err != nil {
		conn.Close()
		return fmt.Errorf("parse open payload: %w", err)
	}

	c.pingInterval = time.Duration(openPayload.PingInterval) * time.Millisecond
	c.pingTimeout = time.Duration(openPayload.PingTimeout) * time.Millisecond
	c.logger.Printf("[sio] Engine.IO open: sid=%s pingInterval=%v pingTimeout=%v", openPayload.SID, c.pingInterval, c.pingTimeout)

	// Send Socket.IO CONNECT packet for the namespace (type 40)
	connectPayload := ""
	if c.auth != nil {
		authJSON, err := json.Marshal(c.auth)
		if err != nil {
			conn.Close()
			return fmt.Errorf("marshal auth: %w", err)
		}
		connectPayload = string(authJSON)
	}

	var connectMsg string
	if c.namespace == "/" {
		if connectPayload != "" {
			connectMsg = "40" + connectPayload
		} else {
			connectMsg = "40"
		}
	} else {
		if connectPayload != "" {
			connectMsg = fmt.Sprintf("40%s,%s", c.namespace, connectPayload)
		} else {
			connectMsg = fmt.Sprintf("40%s,", c.namespace)
		}
	}

	if err := conn.WriteMessage(websocket.TextMessage, []byte(connectMsg)); err != nil {
		conn.Close()
		return fmt.Errorf("send CONNECT: %w", err)
	}

	// Read the Socket.IO CONNECT response
	_, msg, err = conn.ReadMessage()
	if err != nil {
		conn.Close()
		return fmt.Errorf("read CONNECT response: %w", err)
	}

	msgStr := string(msg)
	// Expect "40/runner,{...}" or "40{...}" for default namespace
	if strings.HasPrefix(msgStr, "44") {
		conn.Close()
		return fmt.Errorf("Socket.IO CONNECT_ERROR: %s", msgStr[2:])
	}
	if !strings.HasPrefix(msgStr, "40") {
		conn.Close()
		return fmt.Errorf("unexpected CONNECT response: %s", msgStr)
	}

	c.logger.Printf("[sio] Socket.IO connected to namespace %s", c.namespace)

	// Start the read loop and ping loop
	go c.readLoop()
	go c.pingLoop()

	if c.onConnect != nil {
		c.onConnect()
	}

	return nil
}

// Close disconnects the client.
func (c *Client) Close() {
	if c.closed.CompareAndSwap(false, true) {
		close(c.done)
		c.connMu.Lock()
		if c.conn != nil {
			c.conn.Close()
		}
		c.connMu.Unlock()
	}
}

// Done returns a channel that closes when the client is disconnected.
func (c *Client) Done() <-chan struct{} {
	return c.done
}

func (c *Client) buildWSURL() (string, error) {
	u, err := url.Parse(c.url)
	if err != nil {
		return "", err
	}

	// Convert http(s) to ws(s)
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
		// already correct
	default:
		u.Scheme = "wss"
	}

	u.Path = "/socket.io/"
	q := u.Query()
	q.Set("EIO", "4")
	q.Set("transport", "websocket")
	u.RawQuery = q.Encode()

	return u.String(), nil
}

func (c *Client) readLoop() {
	defer func() {
		if c.closed.CompareAndSwap(false, true) {
			close(c.done)
		}
		if c.onDisconnect != nil {
			c.onDisconnect("transport close")
		}
	}()

	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			if !c.closed.Load() {
				c.logger.Printf("[sio] read error: %v", err)
			}
			return
		}

		c.handleMessage(string(msg))
	}
}

func (c *Client) handleMessage(msg string) {
	if len(msg) == 0 {
		return
	}

	// Engine.IO packet type is the first character
	switch msg[0] {
	case '2': // ping from server
		if c.logger != nil {
			c.logger.Printf("[sio] received EIO ping, sending pong")
		}
		c.connMu.Lock()
		if c.conn != nil {
			c.conn.WriteMessage(websocket.TextMessage, []byte("3")) // pong
		}
		c.connMu.Unlock()
		// Signal the ping monitor
		select {
		case c.lastPing <- struct{}{}:
		default:
		}
	case '3': // pong (unexpected in EIO4 client mode, but handle gracefully)
		// ok
	case '4': // message (Socket.IO)
		c.handleSIOMessage(msg[1:])
	case '1': // close
		c.Close()
	case '6': // noop
		// ignore
	}
}

func (c *Client) handleSIOMessage(msg string) {
	if len(msg) == 0 {
		return
	}

	// Socket.IO packet type
	switch msg[0] {
	case '0': // CONNECT (shouldn't happen here, handled in Connect())
	case '1': // DISCONNECT
		c.Close()
	case '2': // EVENT
		c.handleEvent(msg[1:])
	case '3': // ACK
		// ignore for now
	case '4': // CONNECT_ERROR
		c.logger.Printf("[sio] CONNECT_ERROR: %s", msg[1:])
	}
}

func (c *Client) handleEvent(msg string) {
	// Strip namespace prefix if present
	// Format: "/runner,["event_name",{...}]" or "["event_name",{...}]"
	data := msg
	if len(data) > 0 && data[0] == '/' {
		// Find the comma separator after the namespace
		idx := strings.Index(data, ",")
		if idx >= 0 {
			data = data[idx+1:]
		}
	}

	// Also strip any numeric ack ID prefix
	start := 0
	for start < len(data) && data[start] >= '0' && data[start] <= '9' {
		start++
	}
	data = data[start:]

	// Parse the JSON array: ["event_name", arg1, arg2, ...]
	var arr []json.RawMessage
	if err := json.Unmarshal([]byte(data), &arr); err != nil {
		c.logger.Printf("[sio] parse event error: %v (data=%q)", err, data)
		return
	}

	if len(arr) < 1 {
		return
	}

	var eventName string
	if err := json.Unmarshal(arr[0], &eventName); err != nil {
		c.logger.Printf("[sio] parse event name error: %v", err)
		return
	}

	// Merge remaining args into a single payload (most events have exactly one arg)
	var payload json.RawMessage
	if len(arr) > 1 {
		payload = arr[1]
	} else {
		payload = json.RawMessage("{}")
	}

	c.handlersMu.RLock()
	handlers := c.handlers[eventName]
	c.handlersMu.RUnlock()

	for _, handler := range handlers {
		handler(payload)
	}
}

func (c *Client) pingLoop() {
	// In Engine.IO v4 (EIO=4), the SERVER sends pings ("2") and the CLIENT
	// responds with pongs ("3"). The client does NOT initiate pings.
	//
	// This loop monitors for ping timeout: if the server doesn't send a ping
	// within (pingInterval + pingTimeout), we assume the connection is dead.
	timeout := c.pingInterval + c.pingTimeout
	if timeout == 0 {
		timeout = 85 * time.Second // default: 25s interval + 60s timeout
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case <-c.done:
			return
		case <-c.lastPing:
			// Server sent a ping — reset the timer
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(timeout)
		case <-timer.C:
			if c.logger != nil {
				c.logger.Printf("[sio] ping timeout — no server ping in %v", timeout)
			}
			c.Close()
			return
		}
	}
}
