package sessions

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// JSONLStore is a SessionStore backed by append-only JSONL files.
//
// File layout:
//
//	<baseDir>/sessions/<encoded-cwd>/<session-id>.jsonl
//
// Line 1  – Session metadata JSON (Updated reflects creation time only)
// Line 2+ – Event JSON objects (one per line), appended over time
//
// Concurrency: the embedded mutex provides safe concurrent access within a
// single process. Multi-process access to the same baseDir is NOT safe without
// external file locking (e.g. flock(2)) — the mutex has no cross-process
// visibility.
type JSONLStore struct {
	baseDir string
	mu      sync.RWMutex // guards all file operations
}

// NewJSONLStore creates a new JSONLStore rooted at baseDir.
// The directory is created (including parents) if it does not exist.
func NewJSONLStore(baseDir string) *JSONLStore {
	return &JSONLStore{baseDir: baseDir}
}

// encodeCWD converts an absolute (or relative) cwd path into a string that is
// safe to use as a directory name on any OS. We use URL percent-encoding so the
// result is reversible, human-readable in simple cases, and avoids the path
// separator ('/') as well as other special characters.
func encodeCWD(cwd string) string {
	return url.PathEscape(cwd)
}

// sessionsDir returns the per-cwd directory that holds all session files for
// that working directory.
func (s *JSONLStore) sessionsDir(cwd string) string {
	return filepath.Join(s.baseDir, "sessions", encodeCWD(cwd))
}

// sessionPath returns the full path to a session's JSONL file.
// It looks up the session file by scanning all cwd subdirectories.
// For Create/AppendEvents/Delete where the cwd is known, use sessionPathForCWD.
func (s *JSONLStore) sessionPathForCWD(cwd, id string) string {
	return filepath.Join(s.sessionsDir(cwd), id+".jsonl")
}

// findSessionPath searches all cwd-encoded subdirectories for a file named
// <id>.jsonl. Returns an error if not found.
func (s *JSONLStore) findSessionPath(id string) (string, error) {
	sessionsRoot := filepath.Join(s.baseDir, "sessions")
	entries, err := os.ReadDir(sessionsRoot)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("session %q not found", id)
		}
		return "", err
	}
	target := id + ".jsonl"
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		candidate := filepath.Join(sessionsRoot, entry.Name(), target)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("session %q not found", id)
}

// Create writes session metadata as the first line of a new JSONL file.
// Returns an error if session.CWD is empty or if a file for this session
// already exists.
func (s *JSONLStore) Create(_ context.Context, session *Session) error {
	if session.CWD == "" {
		return fmt.Errorf("sessions.Create: CWD must not be empty")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	dir := s.sessionsDir(session.CWD)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("sessions.Create: mkdir: %w", err)
	}

	path := s.sessionPathForCWD(session.CWD, session.ID)
	// O_EXCL ensures we fail if the file already exists.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return fmt.Errorf("sessions.Create: session %q already exists", session.ID)
		}
		return fmt.Errorf("sessions.Create: open: %w", err)
	}
	defer f.Close()

	line, err := json.Marshal(session)
	if err != nil {
		return fmt.Errorf("sessions.Create: marshal: %w", err)
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
		return fmt.Errorf("sessions.Create: write: %w", err)
	}
	return nil
}

// Get reads the first line of the session JSONL file and returns the metadata.
func (s *JSONLStore) Get(_ context.Context, id string) (*Session, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	path, err := s.findSessionPath(id)
	if err != nil {
		return nil, fmt.Errorf("sessions.Get: %w", err)
	}
	return readSessionMeta(path)
}

// List returns metadata for all sessions stored under the given cwd, sorted by
// file modification time descending (most-recently written first).
// Note: the Updated field inside each Session reflects creation time only;
// recency ordering is determined by the file's OS mtime, which advances on
// every AppendEvents call.
// Returns an empty (non-nil) slice when none exist.
func (s *JSONLStore) List(_ context.Context, cwd string) ([]*SessionMeta, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	dir := s.sessionsDir(cwd)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []*SessionMeta{}, nil
		}
		return nil, fmt.Errorf("sessions.List: readdir: %w", err)
	}

	type sessionWithMtime struct {
		meta  *SessionMeta
		mtime time.Time
	}

	var items []sessionWithMtime
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		sess, err := readSessionMeta(path)
		if err != nil {
			// Skip corrupt/empty files; don't abort the whole list.
			continue
		}
		items = append(items, sessionWithMtime{
			meta:  sess,
			mtime: info.ModTime(),
		})
	}

	sort.Slice(items, func(i, j int) bool {
		return items[i].mtime.After(items[j].mtime)
	})

	metas := make([]*SessionMeta, len(items))
	for i, item := range items {
		metas[i] = item.meta
	}
	return metas, nil
}

// AppendEvents opens the session JSONL file in append mode and writes each
// event as an individual JSON line.
func (s *JSONLStore) AppendEvents(_ context.Context, id string, events []Event) error {
	if len(events) == 0 {
		return nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	path, err := s.findSessionPath(id)
	if err != nil {
		return fmt.Errorf("sessions.AppendEvents: %w", err)
	}

	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("sessions.AppendEvents: open: %w", err)
	}
	defer f.Close()

	w := bufio.NewWriter(f)
	for _, ev := range events {
		line, err := json.Marshal(ev)
		if err != nil {
			return fmt.Errorf("sessions.AppendEvents: marshal: %w", err)
		}
		if _, err := w.Write(append(line, '\n')); err != nil {
			return fmt.Errorf("sessions.AppendEvents: write: %w", err)
		}
	}
	if err := w.Flush(); err != nil {
		return fmt.Errorf("sessions.AppendEvents: flush: %w", err)
	}
	return nil
}

// LoadEvents reads all event lines (lines 2+) from the session JSONL file.
// Corrupt or truncated lines (e.g. from a crash mid-flush) are skipped with a
// warning to stderr; all valid events before and after such lines are returned.
func (s *JSONLStore) LoadEvents(_ context.Context, id string) ([]Event, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	path, err := s.findSessionPath(id)
	if err != nil {
		return nil, fmt.Errorf("sessions.LoadEvents: %w", err)
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("sessions.LoadEvents: open: %w", err)
	}
	defer f.Close()

	var events []Event
	scanner := bufio.NewScanner(f)
	// Set a large buffer to handle potentially large event JSON.
	scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024)

	lineNum := 0
	for scanner.Scan() {
		lineNum++
		if lineNum == 1 {
			// Skip the metadata line.
			continue
		}
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var ev Event
		if err := json.Unmarshal(line, &ev); err != nil {
			// Skip corrupt/truncated lines (e.g. from a crash mid-flush).
			// All valid events before and after this line are still returned.
			fmt.Fprintf(os.Stderr, "sessions.LoadEvents: skipping corrupt line %d in %s: %v\n", lineNum, path, err)
			continue
		}
		events = append(events, ev)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("sessions.LoadEvents: scan: %w", err)
	}
	return events, nil
}

// Delete removes the JSONL file for the given session ID.
func (s *JSONLStore) Delete(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	path, err := s.findSessionPath(id)
	if err != nil {
		return fmt.Errorf("sessions.Delete: %w", err)
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("sessions.Delete: remove: %w", err)
	}
	return nil
}

// readSessionMeta reads and parses only the first line of a JSONL session file.
func readSessionMeta(path string) (*Session, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("readSessionMeta: open %s: %w", path, err)
	}
	defer f.Close()

	r := bufio.NewReader(f)
	line, err := r.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("readSessionMeta: read %s: %w", path, err)
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return nil, fmt.Errorf("readSessionMeta: empty file %s", path)
	}

	var sess Session
	if err := json.Unmarshal([]byte(line), &sess); err != nil {
		return nil, fmt.Errorf("readSessionMeta: parse %s: %w", path, err)
	}
	return &sess, nil
}
