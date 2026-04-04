package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/compaction"
	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/sessions"
)

// collectingEmitter collects relay events for test assertions.
type collectingEmitter struct {
	mu     sync.Mutex
	events []RelayEvent
}

func (c *collectingEmitter) emit(ev RelayEvent) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, ev)
}

func (c *collectingEmitter) getEvents() []RelayEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	cp := make([]RelayEvent, len(c.events))
	copy(cp, c.events)
	return cp
}

func (c *collectingEmitter) eventTypes() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	types := make([]string, 0, len(c.events))
	for _, ev := range c.events {
		if t, ok := ev["type"].(string); ok {
			types = append(types, t)
		}
	}
	return types
}

func setupTestStore(t *testing.T) sessions.SessionStore {
	t.Helper()
	dir := t.TempDir()
	return sessions.NewJSONLStore(dir)
}

func setupTestCompaction(t *testing.T, store sessions.SessionStore) (*sessionCompaction, *collectingEmitter, *collectingEmitter) {
	t.Helper()
	relayEmitter := &collectingEmitter{}
	runnerEmitter := &collectingEmitter{}
	logger := newTestLogger()

	sc := newSessionCompaction(
		"test-session-123",
		"/tmp/test-cwd",
		store,
		logger,
		relayEmitter.emit,
		runnerEmitter.emit,
	)
	return sc, relayEmitter, runnerEmitter
}

func TestSessionCompaction_TrackMessages(t *testing.T) {
	store := setupTestStore(t)
	sc, _, _ := setupTestCompaction(t, store)

	sc.TrackUserMessage("hello")
	sc.TrackAssistantMessage("hi there")
	sc.TrackUserMessage("how are you?")

	sc.mu.Lock()
	defer sc.mu.Unlock()

	if len(sc.messages) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(sc.messages))
	}
	if sc.turnCount != 2 {
		t.Fatalf("expected turn count 2, got %d", sc.turnCount)
	}
	if sc.messages[0].Role != "user" || sc.messages[0].Content != "hello" {
		t.Fatalf("unexpected first message: %+v", sc.messages[0])
	}
	if sc.messages[1].Role != "assistant" || sc.messages[1].Content != "hi there" {
		t.Fatalf("unexpected second message: %+v", sc.messages[1])
	}
}

func TestSessionCompaction_ProactiveCompaction_BelowThreshold(t *testing.T) {
	store := setupTestStore(t)
	sc, relayEmitter, _ := setupTestCompaction(t, store)

	// Add a few short messages — well below the 80k soft threshold.
	for i := 0; i < 10; i++ {
		sc.TrackUserMessage("short message")
		sc.TrackAssistantMessage("short reply")
	}

	result, err := sc.TryProactiveCompaction(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Fatalf("expected no compaction, got result: %+v", result)
	}

	// No compaction events should have been emitted.
	types := relayEmitter.eventTypes()
	for _, typ := range types {
		if typ == "compact_started" || typ == "compact_ended" {
			t.Fatalf("unexpected compaction event: %s", typ)
		}
	}
}

func TestSessionCompaction_ProactiveCompaction_AboveThreshold(t *testing.T) {
	store := setupTestStore(t)

	// Create the session in the store first.
	err := store.Create(context.Background(), &sessions.Session{
		ID: "test-session-123", CWD: "/tmp/test-cwd",
		Created: time.Now(), Updated: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}

	sc, relayEmitter, runnerEmitter := setupTestCompaction(t, store)

	// Override the policy with very low thresholds for testing.
	sc.executor.Policy = compaction.Policy{
		SoftThresholdTokens:   100,
		HardThresholdTokens:   500,
		MinTurnsBeforeCompact: 2,
	}

	// Add enough messages to exceed the soft threshold.
	// Each message with 400 chars ≈ 100+ tokens (4 overhead + content/4).
	bigMsg := string(make([]byte, 400))
	for i := 0; i < 5; i++ {
		sc.TrackUserMessage(bigMsg)
		sc.TrackAssistantMessage(bigMsg)
	}

	result, err := sc.TryProactiveCompaction(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("expected compaction to run, got nil")
	}
	if result.WasCancelled {
		t.Fatal("expected compaction to complete, got cancelled")
	}
	if result.Error != nil {
		t.Fatalf("compaction error: %v", result.Error)
	}
	if result.Summary.MessagesRemoved == 0 {
		t.Fatal("expected some messages to be removed")
	}
	if result.Generation != 1 {
		t.Fatalf("expected generation 1, got %d", result.Generation)
	}

	// Check relay events were emitted in the correct order:
	// compact_started → heartbeat(isCompacting:true) → message_update(summary) → compact_ended → heartbeat(isCompacting:false)
	relayTypes := relayEmitter.eventTypes()
	expectedOrder := []string{"compact_started", "heartbeat", "message_update", "compact_ended", "heartbeat"}

	if len(relayTypes) < len(expectedOrder) {
		t.Fatalf("expected at least %d relay events, got %d: %v", len(expectedOrder), len(relayTypes), relayTypes)
	}

	// Verify the sequence contains our expected sub-sequence.
	idx := 0
	for _, rt := range relayTypes {
		if idx < len(expectedOrder) && rt == expectedOrder[idx] {
			idx++
		}
	}
	if idx != len(expectedOrder) {
		t.Fatalf("expected relay event sequence %v, got %v", expectedOrder, relayTypes)
	}

	// Verify runner events include heartbeats with isCompacting flags.
	runnerTypes := runnerEmitter.eventTypes()
	hasCompactingHB := false
	hasNonCompactingHB := false
	for _, ev := range runnerEmitter.getEvents() {
		if ev["type"] == "heartbeat" {
			if ev["isCompacting"] == true {
				hasCompactingHB = true
			} else {
				hasNonCompactingHB = true
			}
		}
	}
	if !hasCompactingHB {
		t.Fatalf("expected heartbeat with isCompacting=true in runner events: %v", runnerTypes)
	}
	if !hasNonCompactingHB {
		t.Fatalf("expected heartbeat with isCompacting=false in runner events: %v", runnerTypes)
	}

	// Verify compaction event was persisted to the session store.
	events, err := store.LoadEvents(context.Background(), "test-session-123")
	if err != nil {
		t.Fatalf("load events: %v", err)
	}
	hasCompactionEvent := false
	for _, ev := range events {
		if ev.Type == "compaction" {
			hasCompactionEvent = true
			var data map[string]any
			if err := json.Unmarshal(ev.Data, &data); err != nil {
				t.Fatalf("unmarshal compaction data: %v", err)
			}
			if data["generation"] == nil {
				t.Fatal("compaction event missing generation")
			}
		}
	}
	if !hasCompactionEvent {
		t.Fatal("expected compaction event in session store")
	}
}

func TestSessionCompaction_ForceCompaction(t *testing.T) {
	store := setupTestStore(t)

	err := store.Create(context.Background(), &sessions.Session{
		ID: "test-session-123", CWD: "/tmp/test-cwd",
		Created: time.Now(), Updated: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}

	sc, relayEmitter, _ := setupTestCompaction(t, store)

	// Even with very few messages, ForceCompact should run.
	sc.TrackUserMessage("hello")
	sc.TrackAssistantMessage("world")

	result, err := sc.ForceCompaction(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("expected compaction to run")
	}
	if result.Error != nil {
		t.Fatalf("compaction error: %v", result.Error)
	}

	// Should have emitted compact_started and compact_ended.
	relayTypes := relayEmitter.eventTypes()
	hasStarted := false
	hasEnded := false
	for _, rt := range relayTypes {
		if rt == "compact_started" {
			hasStarted = true
		}
		if rt == "compact_ended" {
			hasEnded = true
		}
	}
	if !hasStarted {
		t.Fatal("expected compact_started event")
	}
	if !hasEnded {
		t.Fatal("expected compact_ended event")
	}
}

func TestSessionCompaction_MinTurnsRespected(t *testing.T) {
	store := setupTestStore(t)
	sc, _, _ := setupTestCompaction(t, store)

	// Override policy: need 5 turns, soft threshold at 1 token.
	sc.executor.Policy = compaction.Policy{
		SoftThresholdTokens:   1,
		HardThresholdTokens:   10_000_000,
		MinTurnsBeforeCompact: 5,
	}

	// Only 2 turns — below MinTurnsBeforeCompact.
	sc.TrackUserMessage("msg1")
	sc.TrackAssistantMessage("reply1")
	sc.TrackUserMessage("msg2")
	sc.TrackAssistantMessage("reply2")

	result, err := sc.TryProactiveCompaction(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Fatal("expected compaction to be skipped due to min turns")
	}
}

func TestSessionCompaction_IsCompacting(t *testing.T) {
	store := setupTestStore(t)
	sc, _, _ := setupTestCompaction(t, store)

	if sc.IsCompacting() {
		t.Fatal("should not be compacting initially")
	}
}

func TestSessionCompaction_PersistEvent(t *testing.T) {
	store := setupTestStore(t)

	err := store.Create(context.Background(), &sessions.Session{
		ID: "test-session-123", CWD: "/tmp/test-cwd",
		Created: time.Now(), Updated: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}

	sc, _, _ := setupTestCompaction(t, store)

	sc.PersistEvent("message_update", map[string]any{
		"role":    "assistant",
		"content": "hello world",
	})

	events, err := store.LoadEvents(context.Background(), "test-session-123")
	if err != nil {
		t.Fatalf("load events: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Type != "message_update" {
		t.Fatalf("expected message_update event, got %s", events[0].Type)
	}
}

func TestIsContextOverflow(t *testing.T) {
	r := &GoRunner{}

	tests := []struct {
		name     string
		ev       RelayEvent
		expected bool
	}{
		{
			name:     "context too long",
			ev:       RelayEvent{"type": "error", "error": "Context is too long for the model"},
			expected: true,
		},
		{
			name:     "context length exceeded",
			ev:       RelayEvent{"type": "result", "error": "context_length exceeded"},
			expected: true,
		},
		{
			name:     "context overflow",
			ev:       RelayEvent{"type": "error", "error": "Context overflow detected"},
			expected: true,
		},
		{
			name:     "max_tokens error",
			ev:       RelayEvent{"type": "error", "error": "max_tokens limit reached"},
			expected: true,
		},
		{
			name:     "session too large",
			ev:       RelayEvent{"type": "result", "error": "Session context is too large"},
			expected: true,
		},
		{
			name:     "normal error",
			ev:       RelayEvent{"type": "error", "error": "network timeout"},
			expected: false,
		},
		{
			name:     "heartbeat event",
			ev:       RelayEvent{"type": "heartbeat"},
			expected: false,
		},
		{
			name:     "message event",
			ev:       RelayEvent{"type": "message_update", "content": "hello"},
			expected: false,
		},
		{
			name:     "no error field",
			ev:       RelayEvent{"type": "error"},
			expected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := r.isContextOverflow(tt.ev)
			if got != tt.expected {
				t.Errorf("isContextOverflow(%v) = %v, want %v", tt.ev, got, tt.expected)
			}
		})
	}
}

func TestShouldPersist(t *testing.T) {
	tests := []struct {
		evType   string
		expected bool
	}{
		{"message_update", true},
		{"tool_result_message", true},
		{"session_active", true},
		{"heartbeat", false},
		{"compact_started", false},
		{"compact_ended", false},
	}

	for _, tt := range tests {
		t.Run(tt.evType, func(t *testing.T) {
			if got := shouldPersist(tt.evType); got != tt.expected {
				t.Errorf("shouldPersist(%q) = %v, want %v", tt.evType, got, tt.expected)
			}
		})
	}
}

func TestCompactionRelayEventOrdering(t *testing.T) {
	// Verify the full compaction lifecycle emits events in the order
	// prescribed by the runtime contract:
	// session_before_compact → compact_started → persist → session_compact → compact_ended → refreshed heartbeat

	store := setupTestStore(t)
	err := store.Create(context.Background(), &sessions.Session{
		ID: "test-session-123", CWD: "/tmp/test-cwd",
		Created: time.Now(), Updated: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}

	sc, relayEmitter, _ := setupTestCompaction(t, store)

	// Use a very low threshold so compaction is guaranteed.
	sc.executor.Policy = compaction.Policy{
		SoftThresholdTokens:   1,
		HardThresholdTokens:   10_000_000,
		MinTurnsBeforeCompact: 1,
	}

	sc.TrackUserMessage("hello")
	sc.TrackAssistantMessage("world")

	_, err = sc.TryProactiveCompaction(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	types := relayEmitter.eventTypes()

	// Find the indices of key events.
	startIdx := -1
	endIdx := -1
	summaryIdx := -1
	for i, typ := range types {
		switch typ {
		case "compact_started":
			if startIdx == -1 {
				startIdx = i
			}
		case "compact_ended":
			endIdx = i
		case "message_update":
			summaryIdx = i
		}
	}

	if startIdx == -1 {
		t.Fatal("missing compact_started")
	}
	if endIdx == -1 {
		t.Fatal("missing compact_ended")
	}
	if summaryIdx == -1 {
		t.Fatal("missing compaction summary message_update")
	}

	// Verify ordering.
	if startIdx >= summaryIdx {
		t.Errorf("compact_started (idx=%d) should come before summary message (idx=%d)", startIdx, summaryIdx)
	}
	if summaryIdx >= endIdx {
		t.Errorf("summary message (idx=%d) should come before compact_ended (idx=%d)", summaryIdx, endIdx)
	}
}

// newTestLogger creates a logger for tests.
func newTestLogger() *log.Logger {
	return log.New(os.Stderr, "[test] ", log.LstdFlags)
}
