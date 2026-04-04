package sessions_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/pizzaface/pizzapi/experimental/adk-go/runtime/sessions"
)

// newStore creates a JSONLStore backed by a temporary directory that is cleaned
// up automatically when the test finishes.
func newStore(t *testing.T) *sessions.JSONLStore {
	t.Helper()
	dir, err := os.MkdirTemp("", "sessions-test-*")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return sessions.NewJSONLStore(dir)
}

func makeSession(id, cwd, model string) *sessions.Session {
	now := time.Now().UTC().Truncate(time.Millisecond)
	return &sessions.Session{
		ID:      id,
		CWD:     cwd,
		Model:   model,
		Created: now,
		Updated: now,
	}
}

func makeEvent(typ, payload string) sessions.Event {
	return sessions.Event{
		Type:      typ,
		Timestamp: time.Now().UTC().Truncate(time.Millisecond),
		Data:      json.RawMessage(`"` + payload + `"`),
	}
}

// ---------------------------------------------------------------------------
// Create + Get round-trip
// ---------------------------------------------------------------------------

func TestCreateGet(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	sess := makeSession("abc123", "/home/user/project", "claude-3")
	if err := store.Create(ctx, sess); err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := store.Get(ctx, "abc123")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.ID != sess.ID {
		t.Errorf("ID: got %q, want %q", got.ID, sess.ID)
	}
	if got.CWD != sess.CWD {
		t.Errorf("CWD: got %q, want %q", got.CWD, sess.CWD)
	}
	if got.Model != sess.Model {
		t.Errorf("Model: got %q, want %q", got.Model, sess.Model)
	}
	if !got.Created.Equal(sess.Created) {
		t.Errorf("Created: got %v, want %v", got.Created, sess.Created)
	}
}

func TestCreateDuplicate(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	sess := makeSession("dup1", "/tmp/proj", "gpt-4")
	if err := store.Create(ctx, sess); err != nil {
		t.Fatalf("first Create: %v", err)
	}
	if err := store.Create(ctx, sess); err == nil {
		t.Fatal("expected error on duplicate Create, got nil")
	}
}

func TestGetNotFound(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	_, err := store.Get(ctx, "nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent session, got nil")
	}
}

// ---------------------------------------------------------------------------
// AppendEvents + LoadEvents
// ---------------------------------------------------------------------------

func TestAppendLoadEvents(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	sess := makeSession("evt1", "/tmp/evts", "claude-3")
	if err := store.Create(ctx, sess); err != nil {
		t.Fatalf("Create: %v", err)
	}

	events := []sessions.Event{
		makeEvent("message", "hello"),
		makeEvent("tool_use", "bash"),
		makeEvent("tool_result", "ok"),
	}
	if err := store.AppendEvents(ctx, "evt1", events); err != nil {
		t.Fatalf("AppendEvents: %v", err)
	}

	loaded, err := store.LoadEvents(ctx, "evt1")
	if err != nil {
		t.Fatalf("LoadEvents: %v", err)
	}
	if len(loaded) != len(events) {
		t.Fatalf("event count: got %d, want %d", len(loaded), len(events))
	}
	for i, ev := range loaded {
		if ev.Type != events[i].Type {
			t.Errorf("event[%d].Type: got %q, want %q", i, ev.Type, events[i].Type)
		}
	}
}

func TestAppendMultipleBatches(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	sess := makeSession("batch1", "/tmp/batch", "claude-3")
	if err := store.Create(ctx, sess); err != nil {
		t.Fatalf("Create: %v", err)
	}

	for i := 0; i < 5; i++ {
		batch := []sessions.Event{
			makeEvent("message", fmt.Sprintf("msg-%d", i)),
		}
		if err := store.AppendEvents(ctx, "batch1", batch); err != nil {
			t.Fatalf("AppendEvents batch %d: %v", i, err)
		}
	}

	loaded, err := store.LoadEvents(ctx, "batch1")
	if err != nil {
		t.Fatalf("LoadEvents: %v", err)
	}
	if len(loaded) != 5 {
		t.Fatalf("event count: got %d, want 5", len(loaded))
	}
}

func TestLoadEventsEmpty(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	sess := makeSession("empty1", "/tmp/empty", "claude-3")
	if err := store.Create(ctx, sess); err != nil {
		t.Fatalf("Create: %v", err)
	}

	events, err := store.LoadEvents(ctx, "empty1")
	if err != nil {
		t.Fatalf("LoadEvents: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("expected 0 events, got %d", len(events))
	}
}

// ---------------------------------------------------------------------------
// List sessions with cwd encoding
// ---------------------------------------------------------------------------

func TestListSessions(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	cwd := "/Users/alice/my project/с unicode"
	sess1 := makeSession("s1", cwd, "claude-3")
	sess1.Updated = time.Now().UTC().Add(-time.Hour)
	sess2 := makeSession("s2", cwd, "gpt-4")
	sess2.Updated = time.Now().UTC()

	if err := store.Create(ctx, sess1); err != nil {
		t.Fatalf("Create s1: %v", err)
	}
	if err := store.Create(ctx, sess2); err != nil {
		t.Fatalf("Create s2: %v", err)
	}

	list, err := store.List(ctx, cwd)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("list count: got %d, want 2", len(list))
	}
	// Sorted by Updated desc — s2 should be first.
	if list[0].ID != "s2" {
		t.Errorf("first item: got %q, want s2", list[0].ID)
	}
	if list[1].ID != "s1" {
		t.Errorf("second item: got %q, want s1", list[1].ID)
	}
}

func TestListEmptyCWD(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	list, err := store.List(ctx, "/nonexistent/cwd")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if list == nil {
		t.Fatal("List returned nil, want empty slice")
	}
	if len(list) != 0 {
		t.Fatalf("expected empty list, got %d items", len(list))
	}
}

func TestListDifferentCWDs(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	cwd1 := "/home/user/proj1"
	cwd2 := "/home/user/proj2"

	if err := store.Create(ctx, makeSession("p1a", cwd1, "m")); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := store.Create(ctx, makeSession("p2a", cwd2, "m")); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := store.Create(ctx, makeSession("p2b", cwd2, "m")); err != nil {
		t.Fatalf("Create: %v", err)
	}

	list1, err := store.List(ctx, cwd1)
	if err != nil {
		t.Fatalf("List cwd1: %v", err)
	}
	if len(list1) != 1 {
		t.Fatalf("cwd1 count: got %d, want 1", len(list1))
	}

	list2, err := store.List(ctx, cwd2)
	if err != nil {
		t.Fatalf("List cwd2: %v", err)
	}
	if len(list2) != 2 {
		t.Fatalf("cwd2 count: got %d, want 2", len(list2))
	}
}

// ---------------------------------------------------------------------------
// Concurrent append safety
// ---------------------------------------------------------------------------

func TestConcurrentAppend(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	sess := makeSession("concurrent1", "/tmp/concurrent", "claude-3")
	if err := store.Create(ctx, sess); err != nil {
		t.Fatalf("Create: %v", err)
	}

	const goroutines = 10
	const eventsPerGoroutine = 20

	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < eventsPerGoroutine; i++ {
				ev := []sessions.Event{
					makeEvent("message", fmt.Sprintf("g%d-i%d", g, i)),
				}
				if err := store.AppendEvents(ctx, "concurrent1", ev); err != nil {
					t.Errorf("AppendEvents g%d i%d: %v", g, i, err)
				}
			}
		}(g)
	}
	wg.Wait()

	loaded, err := store.LoadEvents(ctx, "concurrent1")
	if err != nil {
		t.Fatalf("LoadEvents: %v", err)
	}
	want := goroutines * eventsPerGoroutine
	if len(loaded) != want {
		t.Fatalf("event count: got %d, want %d", len(loaded), want)
	}
}

// ---------------------------------------------------------------------------
// Corrupt / empty file handling
// ---------------------------------------------------------------------------

func TestCorruptFileHandling(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	// Create a valid session first so the directory exists.
	validSess := makeSession("valid1", "/tmp/corrupt", "m")
	if err := store.Create(ctx, validSess); err != nil {
		t.Fatalf("Create valid: %v", err)
	}

	// Manually write a corrupt file into the same cwd directory.
	dir := store.SessionsDirForTest("/tmp/corrupt")
	corruptPath := dir + "/corrupt-session.jsonl"
	if err := os.WriteFile(corruptPath, []byte("not-json\n"), 0o644); err != nil {
		t.Fatalf("WriteFile corrupt: %v", err)
	}

	// List should skip the corrupt file and return the valid one.
	list, err := store.List(ctx, "/tmp/corrupt")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("list count: got %d, want 1 (corrupt file should be skipped)", len(list))
	}
	if list[0].ID != "valid1" {
		t.Errorf("item ID: got %q, want valid1", list[0].ID)
	}
}

func TestEmptyFileHandling(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	// Create a valid session so the directory exists.
	validSess := makeSession("valid2", "/tmp/empty-file", "m")
	if err := store.Create(ctx, validSess); err != nil {
		t.Fatalf("Create valid: %v", err)
	}

	// Manually write an empty file into the same cwd directory.
	dir := store.SessionsDirForTest("/tmp/empty-file")
	emptyPath := dir + "/empty-session.jsonl"
	if err := os.WriteFile(emptyPath, []byte{}, 0o644); err != nil {
		t.Fatalf("WriteFile empty: %v", err)
	}

	// List should skip the empty file gracefully.
	list, err := store.List(ctx, "/tmp/empty-file")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("list count: got %d, want 1 (empty file should be skipped)", len(list))
	}
}

func TestGetCorruptFile(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	// Write a corrupt file and try to Get it — should return an error, not panic.
	validSess := makeSession("corrupt-get", "/tmp/corrupt-get", "m")
	if err := store.Create(ctx, validSess); err != nil {
		t.Fatalf("Create: %v", err)
	}
	dir := store.SessionsDirForTest("/tmp/corrupt-get")
	// Overwrite the valid file with corrupt content.
	if err := os.WriteFile(dir+"/corrupt-get.jsonl", []byte("bad json\n"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	_, err := store.Get(ctx, "corrupt-get")
	if err == nil {
		t.Fatal("expected error for corrupt file, got nil")
	}
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

func TestDelete(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	sess := makeSession("del1", "/tmp/del", "claude-3")
	if err := store.Create(ctx, sess); err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := store.Delete(ctx, "del1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	_, err := store.Get(ctx, "del1")
	if err == nil {
		t.Fatal("expected error after Delete, got nil")
	}
}

func TestDeleteNotFound(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	if err := store.Delete(ctx, "ghost"); err == nil {
		t.Fatal("expected error deleting nonexistent session, got nil")
	}
}

// ---------------------------------------------------------------------------
// Large session (>100 events)
// ---------------------------------------------------------------------------

func TestLargeSession(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	sess := makeSession("large1", "/tmp/large", "claude-3")
	if err := store.Create(ctx, sess); err != nil {
		t.Fatalf("Create: %v", err)
	}

	const total = 200
	events := make([]sessions.Event, total)
	for i := range events {
		events[i] = makeEvent("message", fmt.Sprintf("payload-%d", i))
	}

	start := time.Now()
	if err := store.AppendEvents(ctx, "large1", events); err != nil {
		t.Fatalf("AppendEvents: %v", err)
	}
	appendDur := time.Since(start)

	start = time.Now()
	loaded, err := store.LoadEvents(ctx, "large1")
	if err != nil {
		t.Fatalf("LoadEvents: %v", err)
	}
	loadDur := time.Since(start)

	if len(loaded) != total {
		t.Fatalf("event count: got %d, want %d", len(loaded), total)
	}

	// Performance smoke-test: both operations should finish well under 1 second
	// for 200 small events on any reasonable machine.
	if appendDur > 2*time.Second {
		t.Errorf("AppendEvents took too long: %v", appendDur)
	}
	if loadDur > 2*time.Second {
		t.Errorf("LoadEvents took too long: %v", loadDur)
	}
	t.Logf("AppendEvents(%d events): %v, LoadEvents: %v", total, appendDur, loadDur)
}
