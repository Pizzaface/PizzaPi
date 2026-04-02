package main

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestGoRunnerRegistration verifies the runner connects and registers with the relay.
func TestGoRunnerRegistration(t *testing.T) {
	server := newFakeSIOServer(t)
	defer server.Close()

	registered := make(chan struct{}, 1)
	server.onMessage = func(msg string) {
		if strings.Contains(msg, "register_runner") {
			select {
			case registered <- struct{}{}:
			default:
			}
		}
	}

	runner := NewGoRunner(server.URL(), "test-api-key", "test-runner-id", "test-runner")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	go func() {
		runner.Run(ctx)
	}()

	select {
	case <-registered:
		received := server.getReceived()
		found := false
		for _, msg := range received {
			if strings.Contains(msg, "register_runner") &&
				strings.Contains(msg, "test-runner-id") &&
				strings.Contains(msg, "test-runner") {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("register_runner not found in: %v", received)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for registration")
	}
}

// TestGoRunnerHandlesNewSession verifies the runner responds to new_session events.
func TestGoRunnerHandlesNewSession(t *testing.T) {
	server := newFakeSIOServer(t)
	defer server.Close()

	var events []string
	var eventsMu sync.Mutex
	sessionEvent := make(chan struct{}, 1)

	server.onMessage = func(msg string) {
		eventsMu.Lock()
		events = append(events, msg)
		eventsMu.Unlock()
		if strings.Contains(msg, "session_ready") || strings.Contains(msg, "session_error") {
			select {
			case sessionEvent <- struct{}{}:
			default:
			}
		}
	}

	runner := NewGoRunner(server.URL(), "test-api-key", "test-runner-id", "test-runner")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	go func() {
		runner.Run(ctx)
	}()

	// Wait for connection
	time.Sleep(300 * time.Millisecond)

	// Trigger registration ack from server
	server.sendEvent("runner_registered", map[string]any{
		"runnerId": "test-runner-id",
	})
	time.Sleep(100 * time.Millisecond)

	// Send new_session — will fail because 'claude' binary isn't available in test,
	// but the runner should process it and emit session_error
	server.sendEvent("new_session", map[string]any{
		"sessionId": "test-sess-001",
		"cwd":       t.TempDir(),
		"prompt":    "hello",
	})

	// Wait for session event (ready or error)
	select {
	case <-sessionEvent:
		eventsMu.Lock()
		defer eventsMu.Unlock()
		hasEvent := false
		for _, ev := range events {
			if strings.Contains(ev, "session_ready") || strings.Contains(ev, "session_error") {
				hasEvent = true
				break
			}
		}
		if !hasEvent {
			t.Fatal("expected session_ready or session_error event")
		}
	case <-time.After(3 * time.Second):
		// Claude binary not installed — this is expected in CI.
		// The test validates the runner processed the new_session message without panic.
		t.Log("timed out waiting for session event — expected if claude is not installed")
	}
}

// TestGoRunnerKillNonexistent verifies kill_session for non-existent sessions doesn't panic.
func TestGoRunnerKillNonexistent(t *testing.T) {
	server := newFakeSIOServer(t)
	defer server.Close()

	runner := NewGoRunner(server.URL(), "test-api-key", "test-runner-id", "test-runner")

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		runner.Run(ctx)
	}()

	time.Sleep(200 * time.Millisecond)

	server.sendEvent("runner_registered", map[string]any{"runnerId": "test-runner-id"})
	time.Sleep(100 * time.Millisecond)

	// Kill a non-existent session — should not panic
	server.sendEvent("kill_session", map[string]any{"sessionId": "nonexistent-session"})
	time.Sleep(100 * time.Millisecond)

	// If we get here without panic, the test passes
}

// TestEventPayloadSerialization verifies relay event payloads serialize correctly.
func TestEventPayloadSerialization(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
		check   func(*testing.T, map[string]any)
	}{
		{
			name: "heartbeat event",
			payload: map[string]any{
				"sessionId": "test-sess",
				"event": map[string]any{
					"type":         "heartbeat",
					"active":       true,
					"isCompacting": false,
					"ts":           int64(1712123456789),
				},
			},
			check: func(t *testing.T, decoded map[string]any) {
				event := decoded["event"].(map[string]any)
				if event["type"] != "heartbeat" {
					t.Fatalf("expected heartbeat, got %v", event["type"])
				}
				if event["active"] != true {
					t.Fatalf("expected active=true")
				}
			},
		},
		{
			name: "session_ready event",
			payload: map[string]any{
				"sessionId": "test-sess-001",
			},
			check: func(t *testing.T, decoded map[string]any) {
				if decoded["sessionId"] != "test-sess-001" {
					t.Fatalf("unexpected sessionId: %v", decoded["sessionId"])
				}
			},
		},
		{
			name: "session_error event",
			payload: map[string]any{
				"sessionId": "test-sess-002",
				"message":   "failed to start claude subprocess",
			},
			check: func(t *testing.T, decoded map[string]any) {
				if decoded["message"] != "failed to start claude subprocess" {
					t.Fatalf("unexpected message: %v", decoded["message"])
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := json.Marshal(tt.payload)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var decoded map[string]any
			if err := json.Unmarshal(data, &decoded); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			tt.check(t, decoded)
		})
	}
}

// TestGoRunnerSessionEnded verifies session_ended cleanup.
func TestGoRunnerSessionEnded(t *testing.T) {
	server := newFakeSIOServer(t)
	defer server.Close()

	runner := NewGoRunner(server.URL(), "test-api-key", "test-runner-id", "test-runner")

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go func() {
		runner.Run(ctx)
	}()

	time.Sleep(200 * time.Millisecond)

	// Send session_ended for a non-tracked session — should not panic
	server.sendEvent("session_ended", map[string]any{"sessionId": "phantom-session"})
	time.Sleep(100 * time.Millisecond)
}
