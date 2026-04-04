package relay

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/gorilla/websocket"
)

// FakeSIOServer implements a minimal Engine.IO + Socket.IO v4 server
// for testing the Client. Exported so other packages can reuse it.
type FakeSIOServer struct {
	t         *testing.T
	upgrader  websocket.Upgrader
	conn      *websocket.Conn
	ConnMu    sync.Mutex
	received  []string
	receiveMu sync.Mutex
	OnMessage func(msg string)
	server    *httptest.Server
}

// NewFakeSIOServer creates a fake SIO server for testing.
func NewFakeSIOServer(t *testing.T) *FakeSIOServer {
	t.Helper()
	s := &FakeSIOServer{
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

// URL returns the test server URL.
func (s *FakeSIOServer) URL() string {
	return s.server.URL
}

// Close shuts down the server and websocket.
func (s *FakeSIOServer) Close() {
	s.ConnMu.Lock()
	if s.conn != nil {
		s.conn.Close()
	}
	s.ConnMu.Unlock()
	s.server.Close()
}

// CloseConn closes the server-side websocket connection.
func (s *FakeSIOServer) CloseConn() {
	s.ConnMu.Lock()
	defer s.ConnMu.Unlock()
	if s.conn != nil {
		s.conn.Close()
	}
}

// WriteRaw writes a raw websocket message to the connected client.
// Caller must hold ConnMu.
func (s *FakeSIOServer) WriteRaw(msg string) {
	if s.conn != nil {
		s.conn.WriteMessage(websocket.TextMessage, []byte(msg))
	}
}

func (s *FakeSIOServer) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.t.Logf("upgrade error: %v", err)
		return
	}

	s.ConnMu.Lock()
	s.conn = conn
	s.ConnMu.Unlock()

	// Send Engine.IO open packet
	openPayload := `0{"sid":"test-sid","upgrades":[],"pingInterval":25000,"pingTimeout":20000}`
	s.ConnMu.Lock()
	conn.WriteMessage(websocket.TextMessage, []byte(openPayload))
	s.ConnMu.Unlock()

	// Read Socket.IO CONNECT packet from client
	_, msg, err := conn.ReadMessage()
	if err != nil {
		return
	}

	msgStr := string(msg)
	s.t.Logf("[server] received CONNECT: %s", msgStr)

	// Send Socket.IO CONNECT response — match the namespace from the client
	s.ConnMu.Lock()
	if strings.Contains(msgStr, "/runner") {
		conn.WriteMessage(websocket.TextMessage, []byte(`40/runner,{"sid":"server-sid"}`))
	} else if strings.Contains(msgStr, "/relay") {
		conn.WriteMessage(websocket.TextMessage, []byte(`40/relay,{"sid":"server-sid"}`))
	} else {
		conn.WriteMessage(websocket.TextMessage, []byte(`40{"sid":"server-sid"}`))
	}
	s.ConnMu.Unlock()

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
		if s.OnMessage != nil {
			s.OnMessage(msgStr)
		}
	}
}

// SendEvent sends a Socket.IO event to the connected client.
func (s *FakeSIOServer) SendEvent(ns, event string, data any) {
	payload, _ := json.Marshal(data)
	var msg string
	if ns == "/" || ns == "" {
		msg = `42["` + event + `",` + string(payload) + `]`
	} else {
		msg = `42` + ns + `,["` + event + `",` + string(payload) + `]`
	}
	s.ConnMu.Lock()
	defer s.ConnMu.Unlock()
	if s.conn != nil {
		s.conn.WriteMessage(websocket.TextMessage, []byte(msg))
	}
}

// GetReceived returns a copy of all received messages.
func (s *FakeSIOServer) GetReceived() []string {
	s.receiveMu.Lock()
	defer s.receiveMu.Unlock()
	out := make([]string, len(s.received))
	copy(out, s.received)
	return out
}
