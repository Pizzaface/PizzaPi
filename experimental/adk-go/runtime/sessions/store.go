// Package sessions provides session persistence for the Go runner.
package sessions

import (
	"context"
	"encoding/json"
	"time"
)

// Session holds metadata for a single coding session.
type Session struct {
	ID      string    `json:"id"`
	CWD     string    `json:"cwd"`
	Model   string    `json:"model"`
	Created time.Time `json:"created"`
	Updated time.Time `json:"updated"`
}

// SessionMeta is identical to Session and is used when listing sessions
// (only the first line of each JSONL file is read, so events are not loaded).
type SessionMeta struct {
	ID      string    `json:"id"`
	CWD     string    `json:"cwd"`
	Model   string    `json:"model"`
	Created time.Time `json:"created"`
	Updated time.Time `json:"updated"`
}

// Event represents a single recorded event in a session.
type Event struct {
	Type      string          `json:"type"`      // message, tool_use, tool_result, system, etc.
	Timestamp time.Time       `json:"timestamp"`
	Data      json.RawMessage `json:"data"`
}

// SessionStore defines the persistence interface for sessions.
type SessionStore interface {
	// Create writes a new session to the store. Returns an error if a session
	// with the same ID already exists.
	Create(ctx context.Context, session *Session) error

	// Get retrieves session metadata by ID.
	Get(ctx context.Context, id string) (*Session, error)

	// List returns metadata for all sessions whose CWD matches the given cwd,
	// sorted by Updated descending (most-recently updated first).
	// Returns an empty slice (not an error) when no sessions exist for that cwd.
	List(ctx context.Context, cwd string) ([]*SessionMeta, error)

	// AppendEvents appends the given events to an existing session's JSONL file.
	AppendEvents(ctx context.Context, id string, events []Event) error

	// LoadEvents reads all events recorded for the session (all lines after the
	// first metadata line).
	LoadEvents(ctx context.Context, id string) ([]Event, error)

	// Delete removes the session file entirely.
	Delete(ctx context.Context, id string) error
}
