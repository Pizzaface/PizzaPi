package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

// writeConn sends a text message on the server connection under connMu.
// All writes to the websocket conn MUST go through this method to avoid
// concurrent write races (gorilla/websocket does not allow concurrent writes).
func (s *fakeSIOServer) writeConn(msg string) {
	s.connMu.Lock()
	defer s.connMu.Unlock()
	if s.conn != nil {
		s.conn.WriteMessage(websocket.TextMessage, []byte(msg)) //nolint:errcheck
	}
}

func (s *fakeSIOServer) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.t.Logf("upgrade error: %v", err)
		return
	}

	s.connMu.Lock()
	s.conn = conn
	s.connMu.Unlock()

	// Send Engine.IO open packet
	openPayload := `0{"sid":"test-sid","upgrades":[],"pingInterval":25000,"pingTimeout":20000}`
	s.writeConn(openPayload)

	// Read Socket.IO CONNECT packet from client
	_, msg, err := conn.ReadMessage()
	if err != nil {
		return
	}

	msgStr := string(msg)
	s.t.Logf("[server] received CONNECT: %s", msgStr)

	// Send Socket.IO CONNECT response
	if strings.Contains(msgStr, "/runner") {
		s.writeConn(`40/runner,{"sid":"server-sid"}`)
	} else {
		s.writeConn(`40{"sid":"server-sid"}`)
	}

	// Read loop
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
	s.writeConn(msg)
}

func (s *fakeSIOServer) getReceived() []string {
	s.receiveMu.Lock()
	defer s.receiveMu.Unlock()
	out := make([]string, len(s.received))
	copy(out, s.received)
	return out
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
	server.writeConn("2") // Engine.IO ping

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
	})

	if err := client.Connect(); err != nil {
		t.Fatalf("connect: %v", err)
	}

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
