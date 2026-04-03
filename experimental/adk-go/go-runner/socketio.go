// Package main provides a minimal Socket.IO v4 client for the PizzaPi relay.
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

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// pendingEmit holds a buffered Emit call to be replayed after reconnection.
type pendingEmit struct {
	event string
	data  any
}

// SIOClient is a minimal Socket.IO v4 client for the PizzaPi relay /runner namespace.
//
// Connect() must be called exactly once. The client is not designed to be reused after
// Close() or after reconnect exhaustion.
type SIOClient struct {
	url       string
	namespace string
	auth      map[string]any

	conn   *websocket.Conn
	connMu sync.Mutex

	handlers   map[string][]func(json.RawMessage)
	handlersMu sync.RWMutex

	// pingInterval and pingTimeout are set during dial() under connMu.
	pingInterval time.Duration
	pingTimeout  time.Duration

	// done is closed when the client is fully disconnected (either intentional Close()
	// or reconnection exhausted). It is never closed mid-reconnect.
	done chan struct{}
	// doneOnce ensures done is closed exactly once.
	doneOnce sync.Once

	// pingCancel is the cancel channel for the currently-running pingLoop.
	// It is replaced (under connMu) each time a new connection is established.
	// Closing it signals the old pingLoop to exit before a new one is started.
	pingCancel chan struct{}

	// lastPing is signaled each time the server sends an EIO ping.
	// It is replaced (under connMu) each time a new connection is established.
	lastPing chan struct{}

	// closedIntentionally is set by Close() to suppress reconnection.
	closedIntentionally atomic.Bool

	logger *log.Logger

	onConnect    func()
	onDisconnect func(reason string)

	// Reconnection config.
	reconnectDelay       time.Duration
	reconnectMaxDelay    time.Duration
	maxReconnectAttempts int

	// reconnecting is true while a reconnect loop is in progress.
	reconnecting atomic.Bool

	// emitBuf buffers Emit() calls during reconnection; replayed after reconnect.
	emitBuf   []pendingEmit
	emitBufMu sync.Mutex
}

// SIOClientConfig configures a new SIOClient.
type SIOClientConfig struct {
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

	// ReconnectDelay is the initial backoff duration (default 1s).
	ReconnectDelay time.Duration
	// ReconnectMaxDelay is the maximum backoff duration (default 30s).
	ReconnectMaxDelay time.Duration
	// MaxReconnectAttempts is the max number of reconnect attempts (0 = unlimited).
	MaxReconnectAttempts int
}

// NewSIOClient creates a new Socket.IO client. Call Connect() to establish the connection.
func NewSIOClient(cfg SIOClientConfig) *SIOClient {
	if cfg.Logger == nil {
		cfg.Logger = log.Default()
	}
	if cfg.Namespace == "" {
		cfg.Namespace = "/"
	}
	if cfg.ReconnectDelay == 0 {
		cfg.ReconnectDelay = 1 * time.Second
	}
	if cfg.ReconnectMaxDelay == 0 {
		cfg.ReconnectMaxDelay = 30 * time.Second
	}
	return &SIOClient{
		url:                  cfg.URL,
		namespace:            cfg.Namespace,
		auth:                 cfg.Auth,
		handlers:             make(map[string][]func(json.RawMessage)),
		logger:               cfg.Logger,
		onConnect:            cfg.OnConnect,
		onDisconnect:         cfg.OnDisconnect,
		reconnectDelay:       cfg.ReconnectDelay,
		reconnectMaxDelay:    cfg.ReconnectMaxDelay,
		maxReconnectAttempts: cfg.MaxReconnectAttempts,
	}
}

// On registers an event handler.
func (c *SIOClient) On(event string, handler func(json.RawMessage)) {
	c.handlersMu.Lock()
	defer c.handlersMu.Unlock()
	c.handlers[event] = append(c.handlers[event], handler)
}

// Emit sends a Socket.IO event to the server.
// If the client is currently reconnecting, the emit is buffered and replayed after reconnect.
func (c *SIOClient) Emit(event string, data any) error {
	// If we're reconnecting, buffer the emit.
	if c.reconnecting.Load() {
		c.emitBufMu.Lock()
		c.emitBuf = append(c.emitBuf, pendingEmit{event: event, data: data})
		c.emitBufMu.Unlock()
		c.logger.Printf("[sio] buffered emit %q during reconnection", event)
		return nil
	}

	return c.emitDirect(event, data)
}

// emitDirect sends a Socket.IO event without buffering.
func (c *SIOClient) emitDirect(event string, data any) error {
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
func (c *SIOClient) Connect() error {
	c.done = make(chan struct{})
	c.closedIntentionally.Store(false)

	// Allocate per-connection channels before dial so pingLoop can use them.
	c.connMu.Lock()
	c.pingCancel = make(chan struct{})
	c.lastPing = make(chan struct{}, 1)
	c.connMu.Unlock()

	if err := c.dial(); err != nil {
		return err
	}

	// Start the read loop and ping loop.
	// Snapshot per-connection channels under the lock so pingLoop sees a consistent pair.
	c.connMu.Lock()
	pingCancel := c.pingCancel
	lastPing := c.lastPing
	c.connMu.Unlock()

	go c.readLoop()
	go c.pingLoop(pingCancel, lastPing)

	if c.onConnect != nil {
		c.onConnect()
	}

	return nil
}

// dial performs the Engine.IO + Socket.IO handshake and stores the new connection.
// Callers must hold no locks; dial acquires connMu to update c.conn, c.pingInterval,
// and c.pingTimeout atomically.
func (c *SIOClient) dial() error {
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

	pingInterval := time.Duration(openPayload.PingInterval) * time.Millisecond
	pingTimeout := time.Duration(openPayload.PingTimeout) * time.Millisecond
	c.logger.Printf("[sio] Engine.IO open: sid=%s pingInterval=%v pingTimeout=%v", openPayload.SID, pingInterval, pingTimeout)

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

	// Update conn, pingInterval, and pingTimeout atomically under connMu.
	c.connMu.Lock()
	c.conn = conn
	c.pingInterval = pingInterval
	c.pingTimeout = pingTimeout
	c.connMu.Unlock()

	return nil
}

// Close disconnects the client intentionally — does NOT trigger reconnection.
func (c *SIOClient) Close() {
	if c.closedIntentionally.CompareAndSwap(false, true) {
		c.connMu.Lock()
		if c.conn != nil {
			c.conn.Close()
		}
		// Signal the pingLoop to exit immediately.
		if c.pingCancel != nil {
			close(c.pingCancel)
			c.pingCancel = nil
		}
		c.connMu.Unlock()
		// Close done channel exactly once.
		c.doneOnce.Do(func() { close(c.done) })
	}
}

// Done returns a channel that closes when the client is fully disconnected
// (either via Close() or when all reconnect attempts are exhausted).
func (c *SIOClient) Done() <-chan struct{} {
	return c.done
}

func (c *SIOClient) buildWSURL() (string, error) {
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

func (c *SIOClient) readLoop() {
	for {
		// Snapshot the conn pointer under connMu to avoid a race with Close() /
		// startReconnect() replacing c.conn while we are in ReadMessage().
		c.connMu.Lock()
		conn := c.conn
		c.connMu.Unlock()

		if conn == nil {
			return
		}

		_, msg, err := conn.ReadMessage()
		if err != nil {
			if c.closedIntentionally.Load() {
				// Intentional close — no reconnect.
				if c.onDisconnect != nil {
					c.onDisconnect("io client disconnect")
				}
				return
			}
			c.logger.Printf("[sio] read error: %v", err)
			if c.onDisconnect != nil {
				c.onDisconnect("transport close")
			}
			// Attempt to reconnect.
			if c.startReconnect() {
				// Reconnected successfully — continue reading on the new connection.
				continue
			}
			// Reconnection exhausted — signal done.
			c.doneOnce.Do(func() { close(c.done) })
			return
		}

		c.handleMessage(string(msg))
	}
}

// startReconnect attempts to reconnect with exponential backoff.
// Returns true if reconnection succeeded, false if exhausted or intentional close.
func (c *SIOClient) startReconnect() bool {
	c.reconnecting.Store(true)
	defer c.reconnecting.Store(false)

	delay := c.reconnectDelay
	attempt := 0

	for {
		if c.closedIntentionally.Load() {
			c.logger.Printf("[sio] reconnect cancelled — client closed intentionally")
			return false
		}

		attempt++
		if c.maxReconnectAttempts > 0 && attempt > c.maxReconnectAttempts {
			// Log the number of buffered emits that will be lost.
			c.emitBufMu.Lock()
			dropped := len(c.emitBuf)
			c.emitBuf = nil
			c.emitBufMu.Unlock()
			if dropped > 0 {
				c.logger.Printf("[sio] reconnect exhausted after %d attempts — dropping %d buffered emit(s)", attempt, dropped)
			} else {
				c.logger.Printf("[sio] reconnect exhausted after %d attempts", attempt)
			}
			return false
		}

		// Apply ±25% jitter to the delay.
		jitter := time.Duration(float64(delay) * (0.75 + rand.Float64()*0.5))
		c.logger.Printf("[sio] reconnect attempt %d in %v", attempt, jitter)

		// Wait for the jitter delay, but exit early if Close() is called (P2 fix).
		select {
		case <-time.After(jitter):
		case <-c.done:
			return false
		}

		if c.closedIntentionally.Load() {
			return false
		}

		// Signal the old pingLoop to exit before we replace the connection.
		// Then close the old connection and allocate fresh per-connection channels.
		c.connMu.Lock()
		if c.pingCancel != nil {
			close(c.pingCancel)
		}
		if c.conn != nil {
			c.conn.Close()
			c.conn = nil
		}
		// Allocate fresh channels for the new connection.
		c.pingCancel = make(chan struct{})
		c.lastPing = make(chan struct{}, 1)
		c.connMu.Unlock()

		if err := c.dial(); err != nil {
			c.logger.Printf("[sio] reconnect attempt %d failed: %v", attempt, err)
			// Exponential backoff with cap.
			delay *= 2
			if delay > c.reconnectMaxDelay {
				delay = c.reconnectMaxDelay
			}
			continue
		}

		c.logger.Printf("[sio] reconnected successfully on attempt %d", attempt)

		// Snapshot per-connection channels under connMu so the new pingLoop
		// sees a consistent pair of channels.
		c.connMu.Lock()
		pingCancel := c.pingCancel
		lastPing := c.lastPing
		c.connMu.Unlock()

		// Start a new pingLoop with the fresh channels.
		// The old pingLoop has already received the close signal via the old pingCancel.
		go c.pingLoop(pingCancel, lastPing)

		// Fire OnConnect callback (triggers re-registration).
		if c.onConnect != nil {
			c.onConnect()
		}

		// Replay buffered emits.
		c.replayBufferedEmits()

		return true
	}
}

// replayBufferedEmits drains the emit buffer and sends all pending events.
func (c *SIOClient) replayBufferedEmits() {
	c.emitBufMu.Lock()
	buf := c.emitBuf
	c.emitBuf = nil
	c.emitBufMu.Unlock()

	for _, e := range buf {
		c.logger.Printf("[sio] replaying buffered emit %q", e.event)
		if err := c.emitDirect(e.event, e.data); err != nil {
			c.logger.Printf("[sio] failed to replay emit %q: %v", e.event, err)
		}
	}
}

func (c *SIOClient) handleMessage(msg string) {
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
		// Signal the ping monitor under the same lock so lastPing is always
		// read/written with connMu held (consistent with startReconnect replacing it).
		select {
		case c.lastPing <- struct{}{}:
		default:
		}
		c.connMu.Unlock()
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

func (c *SIOClient) handleSIOMessage(msg string) {
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

func (c *SIOClient) handleEvent(msg string) {
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

// pingLoop monitors for ping timeout on a single connection lifetime.
// pingCancel is closed when this pingLoop should exit (connection replaced or client closed).
// lastPing is signaled each time the server sends an EIO ping.
func (c *SIOClient) pingLoop(pingCancel <-chan struct{}, lastPing <-chan struct{}) {
	// In Engine.IO v4 (EIO=4), the SERVER sends pings ("2") and the CLIENT
	// responds with pongs ("3"). The client does NOT initiate pings.
	//
	// This loop monitors for ping timeout: if the server doesn't send a ping
	// within (pingInterval + pingTimeout), we assume the connection is dead.

	// Read pingInterval and pingTimeout under connMu to avoid a race with dial().
	c.connMu.Lock()
	interval := c.pingInterval
	timeout := c.pingTimeout
	c.connMu.Unlock()

	pingTimeout := interval + timeout
	if pingTimeout == 0 {
		pingTimeout = 85 * time.Second // default: 25s interval + 60s timeout
	}

	timer := time.NewTimer(pingTimeout)
	defer timer.Stop()

	for {
		select {
		case <-pingCancel:
			// Connection replaced or client closed — exit cleanly.
			return
		case <-c.done:
			return
		case <-lastPing:
			// Server sent a ping — reset the timer
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(pingTimeout)
		case <-timer.C:
			if c.closedIntentionally.Load() {
				return
			}
			if c.logger != nil {
				c.logger.Printf("[sio] ping timeout — no server ping in %v", pingTimeout)
			}
			// Close the connection — readLoop will handle reconnection.
			c.connMu.Lock()
			if c.conn != nil {
				c.conn.Close()
			}
			c.connMu.Unlock()
			return
		}
	}
}
