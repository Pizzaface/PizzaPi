package relay

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestClientConnect(t *testing.T) {
	server := NewFakeSIOServer(t)
	defer server.Close()

	connected := make(chan struct{})
	client := NewClient(ClientConfig{
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

func TestClientEmit(t *testing.T) {
	server := NewFakeSIOServer(t)
	defer server.Close()

	client := NewClient(ClientConfig{
		URL:       server.URL(),
		Namespace: "/runner",
		Auth:      map[string]any{"apiKey": "test"},
	})

	if err := client.Connect(); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer client.Close()

	time.Sleep(50 * time.Millisecond)

	err := client.Emit("register_runner", map[string]any{
		"runnerId": "go-test",
		"name":     "test",
	})
	if err != nil {
		t.Fatalf("emit: %v", err)
	}

	time.Sleep(100 * time.Millisecond)

	received := server.GetReceived()
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

func TestClientReceiveEvent(t *testing.T) {
	server := NewFakeSIOServer(t)
	defer server.Close()

	received := make(chan json.RawMessage, 1)
	client := NewClient(ClientConfig{
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

	server.SendEvent("/runner", "runner_registered", map[string]any{
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

func TestClientPingPong(t *testing.T) {
	server := NewFakeSIOServer(t)
	defer server.Close()

	client := NewClient(ClientConfig{
		URL:       server.URL(),
		Namespace: "/runner",
		Auth:      map[string]any{"apiKey": "test"},
	})

	if err := client.Connect(); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer client.Close()

	// Send a ping from the server, expect a pong
	server.ConnMu.Lock()
	server.WriteRaw("2") // Engine.IO ping
	server.ConnMu.Unlock()

	time.Sleep(100 * time.Millisecond)

	received := server.GetReceived()
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

// TestClientCloseReadLoopRace exercises the race window between Close() and
// readLoop's defer path.
func TestClientCloseReadLoopRace(t *testing.T) {
	for i := 0; i < 20; i++ {
		server := NewFakeSIOServer(t)

		client := NewClient(ClientConfig{
			URL:       server.URL(),
			Namespace: "/runner",
			Auth:      map[string]any{"apiKey": "test"},
		})

		if err := client.Connect(); err != nil {
			server.Close()
			t.Fatalf("iteration %d: connect error: %v", i, err)
		}

		var wg sync.WaitGroup
		wg.Add(2)

		go func() {
			defer wg.Done()
			client.Close()
		}()

		go func() {
			defer wg.Done()
			server.CloseConn()
		}()

		wg.Wait()

		select {
		case <-client.Done():
		case <-time.After(2 * time.Second):
			t.Fatalf("iteration %d: timed out waiting for client done", i)
		}

		server.Close()
	}
}

func TestClientDisconnect(t *testing.T) {
	server := NewFakeSIOServer(t)
	defer server.Close()

	disconnected := make(chan string, 1)
	client := NewClient(ClientConfig{
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

	server.CloseConn()

	select {
	case <-disconnected:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for disconnect")
	}
}

func TestShortID(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"", ""},
		{"abc", "abc"},
		{"abcdefgh", "abcdefgh"},
		{"abcdefghi", "abcdefgh"},
		{"abc-def-ghi-jkl", "abc-def-"},
	}
	for _, tt := range tests {
		got := ShortID(tt.input)
		if got != tt.want {
			t.Errorf("ShortID(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}
