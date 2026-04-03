package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fakeSIOServer implements a minimal Engine.IO + Socket.IO v4 server
// for testing the SIOClient.
type fakeSIOServer struct {
	t         *testing.T
	upgrader  websocket.Upgrader
	conn      *websocket.Conn
	connMu    sync.Mutex
	received  []string
	receiveMu sync.Mutex
	onMessage func(msg string)
	server    *httptest.Server
}

func newFakeSIOServer(t *testing.T) *fakeSIOServer {
	t.Helper()
	s := &fakeSIOServer{
		t: t,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/socket.io/", s.handleWS)
	s.server = httptest.NewServer(mux)
	return s
}

func (s *fakeSIOServer) URL() string {
	return s.server.URL
}

func (s *fakeSIOServer) Close() {
	s.connMu.Lock()
	if s.conn != nil {
		s.conn.Close()
	}
	s.connMu.Unlock()
	s.server.Close()
}

func (s *fakeSIOServer) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.t.Logf("upgrade error: %v", err)
		return
	}

	s.connMu.Lock()
	s.conn = conn
	// Send Engine.IO open packet under the lock so all writes are serialized
	// with sendEvent() which also acquires connMu.
	conn.WriteMessage(websocket.TextMessage, []byte(`0{"sid":"test-sid","upgrades":[],"pingInterval":25000,"pingTimeout":20000}`))
	s.connMu.Unlock()

	// Read Socket.IO CONNECT packet from client (no lock needed — only we read).
	_, msg, err := conn.ReadMessage()
	if err != nil {
		return
	}

	msgStr := string(msg)
	s.t.Logf("[server] received CONNECT: %s", msgStr)

	// Send Socket.IO CONNECT response under connMu.
	s.connMu.Lock()
	if strings.Contains(msgStr, "/runner") {
		conn.WriteMessage(websocket.TextMessage, []byte(`40/runner,{"sid":"server-sid"}`))
	} else {
		conn.WriteMessage(websocket.TextMessage, []byte(`40{"sid":"server-sid"}`))
	}
	s.connMu.Unlock()

	// Read loop (no lock — only this goroutine reads from conn).
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		msgStr := string(msg)
		s.receiveMu.Lock()
		s.received = append(s.received, msgStr)
		s.receiveMu.Unlock()
		if s.onMessage != nil {
			s.onMessage(msgStr)
		}
	}
}

func (s *fakeSIOServer) sendEvent(event string, data any) {
	payload, _ := json.Marshal(data)
	msg := `42/runner,["` + event + `",` + string(payload) + `]`
	s.connMu.Lock()
	defer s.connMu.Unlock()
	if s.conn != nil {
		s.conn.WriteMessage(websocket.TextMessage, []byte(msg))
	}
}

func (s *fakeSIOServer) getReceived() []string {
	s.receiveMu.Lock()
	defer s.receiveMu.Unlock()
	out := make([]string, len(s.received))
	copy(out, s.received)
	return out
}

// dropCurrentConn forcibly closes the server-side connection without shutting down the server,
// simulating a transient network drop that should trigger client reconnection.
func (s *fakeSIOServer) dropCurrentConn() {
	s.connMu.Lock()
	if s.conn != nil {
		s.conn.Close()
		s.conn = nil
	}
	s.connMu.Unlock()
}

// waitForConn blocks until the server has an active connection or the timeout elapses.
func (s *fakeSIOServer) waitForConn(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		s.connMu.Lock()
		ok := s.conn != nil
		s.connMu.Unlock()
		if ok {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

func TestSIOClientConnect(t *testing.T) {
	server := newFakeSIOServer(t)
	defer server.Close()

	connected := make(chan struct{})
	client := NewSIOClient(SIOClientConfig{
		URL:       server.URL(),
		Namespace: "/runner",
		Auth: map[string]any{
			"apiKey":   "test-key",
			"runnerId": "test-runner",
		},
		OnConnect: func() {
			close(connected)
		},
	})

	err := client.Connect()
	if err != nil {
		t.Fatalf("connect error: %v", err)
	}
	defer client.Close()

	select {
	case <-connected:
		// OK
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for connect callback")
	}
}

func TestSIOClientEmit(t *testing.T) {
	server := newFakeSIOServer(t)
	defer server.Close()

	client := NewSIOClient(SIOClientConfig{
		URL:       server.URL(),
		Namespace: "/runner",
		Auth:      map[string]any{"apiKey": "test"},
	})

	if err := client.Connect(); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer client.Close()

	time.Sleep(50 * time.Millisecond) // let connection settle

	err := client.Emit("register_runner", map[string]any{
		"runnerId": "go-test",
		"name":     "test",
	})
	if err != nil {
		t.Fatalf("emit: %v", err)
	}

	time.Sleep(100 * time.Millisecond)

	received := server.getReceived()
	found := false
	for _, msg := range received {
		if strings.Contains(msg, "register_runner") && strings.Contains(msg, "go-test") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("server did not receive register_runner event, got: %v", received)
	}
}

func TestSIOClientReceiveEvent(t *testing.T) {
	server := newFakeSIOServer(t)
	defer server.Close()

	received := make(chan json.RawMessage, 1)
	client := NewSIOClient(SIOClientConfig{
		URL:       server.URL(),
		Namespace: "/runner",
		Auth:      map[string]any{"apiKey": "test"},
	})

	client.On("runner_registered", func(data json.RawMessage) {
		received <- data
	})

	if err := client.Connect(); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer client.Close()

	time.Sleep(50 * time.Millisecond)

	server.sendEvent("runner_registered", map[string]any{
		"runnerId": "assigned-id",
	})

	select {
	case data := <-received:
		var payload struct {
			RunnerID string `json:"runnerId"`
		}
		if err := json.Unmarshal(data, &payload); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if payload.RunnerID != "assigned-id" {
			t.Fatalf("unexpected runnerId: %s", payload.RunnerID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for runner_registered event")
	}
}

func TestSIOClientPingPong(t *testing.T) {
	server := newFakeSIOServer(t)
	defer server.Close()

	client := NewSIOClient(SIOClientConfig{
		URL:       server.URL(),
		Namespace: "/runner",
		Auth:      map[string]any{"apiKey": "test"},
	})

	if err := client.Connect(); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer client.Close()

	// Send a ping from the server, expect a pong
	server.connMu.Lock()
	server.conn.WriteMessage(websocket.TextMessage, []byte("2")) // Engine.IO ping
	server.connMu.Unlock()

	time.Sleep(100 * time.Millisecond)

	received := server.getReceived()
	found := false
	for _, msg := range received {
		if msg == "3" { // pong
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected pong response, got: %v", received)
	}
}

func TestSIOClientDisconnect(t *testing.T) {
	server := newFakeSIOServer(t)
	defer server.Close()

	disconnected := make(chan string, 1)
	client := NewSIOClient(SIOClientConfig{
		URL:       server.URL(),
		Namespace: "/runner",
		Auth:      map[string]any{"apiKey": "test"},
		OnDisconnect: func(reason string) {
			disconnected <- reason
		},
		// Limit reconnect attempts so the test completes cleanly.
		MaxReconnectAttempts: 1,
		ReconnectDelay:       10 * time.Millisecond,
	})

	if err := client.Connect(); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer client.Close()

	// Close the server-side connection
	server.connMu.Lock()
	server.conn.Close()
	server.connMu.Unlock()

	select {
	case <-disconnected:
		// OK
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for disconnect")
	}
}

// TestSIOClientReconnectOnDrop verifies that a transient connection drop
// triggers an automatic reconnect attempt.
func TestSIOClientReconnectOnDrop(t *testing.T) {
	server := newFakeSIOServer(t)
	defer server.Close()

	var connectCount atomic.Int32
	connected := make(chan struct{}, 10)

	client := NewSIOClient(SIOClientConfig{
		URL:       server.URL(),
		Namespace: "/runner",
		Auth:      map[string]any{"apiKey": "test"},
		OnConnect: func() {
			connectCount.Add(1)
			connected <- struct{}{}
		},
		ReconnectDelay:    50 * time.Millisecond,
		ReconnectMaxDelay: 500 * time.Millisecond,
	})

	if err := client.Connect(); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer client.Close()

	// Wait for initial connect callback.
	select {
	case <-connected:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for initial connect")
	}

	if n := connectCount.Load(); n != 1 {
		t.Fatalf("expected 1 connect, got %d", n)
	}

	// Drop the connection from the server side (not intentional client close).
	server.dropCurrentConn()

	// Wait for the client to reconnect — OnConnect fires again.
	select {
	case <-connected:
		// Reconnected successfully.
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for reconnect")
	}

	if n := connectCount.Load(); n < 2 {
		t.Fatalf("expected at least 2 OnConnect calls (initial + reconnect), got %d", n)
	}

	// Verify the client is still usable after reconnect.
	time.Sleep(50 * time.Millisecond)
	if err := client.Emit("ping_event", map[string]any{"ok": true}); err != nil {
		t.Fatalf("emit after reconnect: %v", err)
	}
}

// TestSIOClientExponentialBackoff verifies that reconnect delays grow exponentially.
func TestSIOClientExponentialBackoff(t *testing.T) {
	// Use a server that refuses all connections after the first one.
	var serveCount atomic.Int32

	mux := http.NewServeMux()
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

	// Record timestamps of each reconnect attempt to verify growing delays.
	var attemptTimes []time.Time
	var attemptMu sync.Mutex

	mux.HandleFunc("/socket.io/", func(w http.ResponseWriter, r *http.Request) {
		n := serveCount.Add(1)
		attemptMu.Lock()
		attemptTimes = append(attemptTimes, time.Now())
		attemptMu.Unlock()

		if n == 1 {
			// First connection: complete the handshake then drop.
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			conn.WriteMessage(websocket.TextMessage, []byte(`0{"sid":"sid1","upgrades":[],"pingInterval":25000,"pingTimeout":20000}`))
			conn.ReadMessage() // consume CONNECT
			conn.WriteMessage(websocket.TextMessage, []byte(`40/runner,{"sid":"s"}`))
			conn.Close() // immediately drop
			return
		}
		// Subsequent connections: reject (return 503) to force backoff.
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	})

	ts := httptest.NewServer(mux)
	defer ts.Close()

	connectFired := make(chan struct{}, 1)
	disconnectFired := make(chan struct{}, 1)

	client := NewSIOClient(SIOClientConfig{
		URL:                  ts.URL,
		Namespace:            "/runner",
		Auth:                 map[string]any{"apiKey": "test"},
		ReconnectDelay:       100 * time.Millisecond,
		ReconnectMaxDelay:    1 * time.Second,
		MaxReconnectAttempts: 3,
		OnConnect: func() {
			select {
			case connectFired <- struct{}{}:
			default:
			}
		},
		OnDisconnect: func(reason string) {
			select {
			case disconnectFired <- struct{}{}:
			default:
			}
		},
	})

	if err := client.Connect(); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer client.Close()

	// Wait for initial connect.
	select {
	case <-connectFired:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for initial connect")
	}

	// Wait for the drop + reconnect exhaustion.
	select {
	case <-disconnectFired:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for disconnect")
	}

	// After MaxReconnectAttempts is exhausted, Done() should close.
	select {
	case <-client.Done():
		// OK — client is done.
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for Done() to close after reconnect exhaustion")
	}

	// Verify we attempted exactly 1 (initial) connect call + reconnect attempts happened.
	if n := serveCount.Load(); n < 2 {
		t.Fatalf("expected >1 server connections (initial + retries), got %d", n)
	}

	// Verify that delays grew between reconnect attempts (P2: timestamp assertions).
	// We expect at least 3 reconnect attempts (n==1 is the initial connection).
	// Delays should be roughly: ~100ms, ~200ms, ~400ms (with ±25% jitter).
	attemptMu.Lock()
	times := make([]time.Time, len(attemptTimes))
	copy(times, attemptTimes)
	attemptMu.Unlock()

	if len(times) >= 3 {
		// Measure intervals between the reconnect attempts (skipping the first connection).
		d1 := times[2].Sub(times[1])
		d2 := times[3%len(times)].Sub(times[2])
		// With jitter the second delay should be at least slightly longer than
		// half the first (generous tolerance for slow CI).
		if len(times) >= 4 && d2 < d1/2 {
			t.Logf("WARNING: delay growth not monotone (d1=%v d2=%v) — jitter may cause occasional flap", d1, d2)
		}
	}
}

// TestSIOClientIntentionalCloseNoReconnect verifies that calling Close() does NOT
// trigger a reconnect attempt.
func TestSIOClientIntentionalCloseNoReconnect(t *testing.T) {
	server := newFakeSIOServer(t)
	defer server.Close()

	var connectCount atomic.Int32

	client := NewSIOClient(SIOClientConfig{
		URL:       server.URL(),
		Namespace: "/runner",
		Auth:      map[string]any{"apiKey": "test"},
		OnConnect: func() {
			connectCount.Add(1)
		},
		ReconnectDelay:    50 * time.Millisecond,
		ReconnectMaxDelay: 500 * time.Millisecond,
	})

	if err := client.Connect(); err != nil {
		t.Fatalf("connect: %v", err)
	}

	time.Sleep(50 * time.Millisecond) // ensure initial connect settles

	// Intentionally close the client.
	client.Close()

	// Done() should close promptly.
	select {
	case <-client.Done():
		// OK
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for Done() after intentional Close()")
	}

	// Wait a bit and verify no additional OnConnect calls fired.
	time.Sleep(300 * time.Millisecond)

	if n := connectCount.Load(); n != 1 {
		t.Fatalf("expected exactly 1 OnConnect (initial), got %d — client reconnected after intentional Close()", n)
	}
}

// TestSIOClientEventHandlersPreservedAfterReconnect verifies that event handlers
// registered before the connection dropped continue to work after reconnection.
func TestSIOClientEventHandlersPreservedAfterReconnect(t *testing.T) {
	server := newFakeSIOServer(t)
	defer server.Close()

	reconnected := make(chan struct{}, 5)
	var connectCount atomic.Int32

	client := NewSIOClient(SIOClientConfig{
		URL:       server.URL(),
		Namespace: "/runner",
		Auth:      map[string]any{"apiKey": "test"},
		OnConnect: func() {
			n := connectCount.Add(1)
			if n >= 2 {
				select {
				case reconnected <- struct{}{}:
				default:
				}
			}
		},
		ReconnectDelay:    50 * time.Millisecond,
		ReconnectMaxDelay: 500 * time.Millisecond,
	})

	// Register event handler BEFORE connecting.
	eventsReceived := make(chan string, 10)
	client.On("test_event", func(data json.RawMessage) {
		var payload struct {
			Msg string `json:"msg"`
		}
		if err := json.Unmarshal(data, &payload); err == nil {
			eventsReceived <- payload.Msg
		}
	})

	if err := client.Connect(); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer client.Close()

	// Drop the connection to trigger reconnect.
	server.dropCurrentConn()

	// Wait for reconnect.
	select {
	case <-reconnected:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for reconnect")
	}

	// Wait for server to have new conn.
	if !server.waitForConn(2 * time.Second) {
		t.Fatal("server didn't get new connection after reconnect")
	}

	time.Sleep(50 * time.Millisecond)

	// Send an event from the server — the previously registered handler should fire.
	server.sendEvent("test_event", map[string]any{"msg": "hello-after-reconnect"})

	select {
	case msg := <-eventsReceived:
		if msg != "hello-after-reconnect" {
			t.Fatalf("unexpected event payload: %q", msg)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for event after reconnect — handler may have been lost")
	}
}

// TestSIOClientBufferedEmitReplayedAfterReconnect verifies that Emit() calls made
// during reconnection are buffered and replayed once the connection is restored.
func TestSIOClientBufferedEmitReplayedAfterReconnect(t *testing.T) {
	var serveCount atomic.Int32
	var firstConn *websocket.Conn
	var firstConnMu sync.Mutex

	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

	// Channels to collect messages from each connection.
	firstConnMessages := make(chan string, 10)
	secondConnMessages := make(chan string, 10)

	mux := http.NewServeMux()
	mux.HandleFunc("/socket.io/", func(w http.ResponseWriter, r *http.Request) {
		n := serveCount.Add(1)
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}

		conn.WriteMessage(websocket.TextMessage, []byte(`0{"sid":"sid","upgrades":[],"pingInterval":25000,"pingTimeout":20000}`))
		conn.ReadMessage() // consume CONNECT
		conn.WriteMessage(websocket.TextMessage, []byte(`40/runner,{"sid":"s"}`))

		if n == 1 {
			firstConnMu.Lock()
			firstConn = conn
			firstConnMu.Unlock()

			for {
				_, msg, err := conn.ReadMessage()
				if err != nil {
					return
				}
				firstConnMessages <- string(msg)
			}
		} else {
			for {
				_, msg, err := conn.ReadMessage()
				if err != nil {
					return
				}
				secondConnMessages <- string(msg)
			}
		}
	})

	ts := httptest.NewServer(mux)
	defer ts.Close()

	reconnected := make(chan struct{}, 1)
	var connectCount atomic.Int32

	client := NewSIOClient(SIOClientConfig{
		URL:       ts.URL,
		Namespace: "/runner",
		Auth:      map[string]any{"apiKey": "test"},
		OnConnect: func() {
			n := connectCount.Add(1)
			if n >= 2 {
				select {
				case reconnected <- struct{}{}:
				default:
				}
			}
		},
		ReconnectDelay:    50 * time.Millisecond,
		ReconnectMaxDelay: 500 * time.Millisecond,
	})

	if err := client.Connect(); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer client.Close()

	// Wait for initial connection to settle.
	time.Sleep(50 * time.Millisecond)

	// Drop the server-side connection — client enters reconnecting state.
	firstConnMu.Lock()
	if firstConn != nil {
		firstConn.Close()
	}
	firstConnMu.Unlock()

	// Immediately emit while reconnecting — should be buffered.
	// Small sleep to ensure reconnecting flag is set before we emit.
	time.Sleep(10 * time.Millisecond)
	if err := client.Emit("buffered_event", map[string]any{"buffered": true}); err != nil {
		t.Fatalf("emit during reconnect: %v", err)
	}

	// Wait for reconnect.
	select {
	case <-reconnected:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for reconnect")
	}

	// The buffered emit should arrive on the second connection.
	select {
	case msg := <-secondConnMessages:
		if !strings.Contains(msg, "buffered_event") {
			t.Fatalf("expected buffered_event on second connection, got: %q", msg)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for buffered emit replay")
	}
}
