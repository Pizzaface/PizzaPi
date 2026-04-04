package main

import (
	"encoding/json"
	"log"
	"os"
	"testing"

	claudecli "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/providers/claudecli"
	guardrails "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/guardrails"
)

// newTestProvider returns a ClaudeCLIProvider wired for unit testing:
//   - No real subprocess; stdin writes go to stdinBuf.
//   - guardEnv and stdinWriter are injected directly.
func newTestProvider(env guardrails.EvalEnv, stdinBuf *[][]byte) *ClaudeCLIProvider {
	p := &ClaudeCLIProvider{
		adapter: claudecli.NewAdapter(),
		logger:  log.New(os.Stderr, "[test] ", 0),
		events:  make(chan RelayEvent, 32),
		done:    make(chan struct{}),
		guardEnv: env,
	}
	p.stdinWriter = func(b []byte) error {
		*stdinBuf = append(*stdinBuf, append([]byte(nil), b...))
		return nil
	}
	return p
}

// runBridge runs bridge() synchronously with a slice of pre-built events and
// returns all relay events that were emitted.
func runBridge(p *ClaudeCLIProvider, rawEvents []claudecli.ClaudeEvent) []RelayEvent {
	ch := make(chan claudecli.ClaudeEvent, len(rawEvents))
	for _, ev := range rawEvents {
		ch <- ev
	}
	close(ch)

	p.bridge(ch)

	var out []RelayEvent
	for ev := range p.events {
		out = append(out, ev)
	}
	return out
}

// toolUseEvent builds a ToolUseEvent with the given args marshalled as JSON.
func toolUseEvent(id, name string, args map[string]any) *claudecli.ToolUseEvent {
	raw, _ := json.Marshal(args)
	return &claudecli.ToolUseEvent{ToolID: id, Name: name, Input: raw}
}

// TestDeniedToolCallEmitsErrorEvent verifies that when a tool call is denied by
// guardrails, a tool_result_message relay event with isError=true is emitted
// and the original tool_use event is NOT forwarded.
func TestDeniedToolCallEmitsErrorEvent(t *testing.T) {
	var stdinWrites [][]byte
	env := guardrails.EvalEnv{
		CWD:     t.TempDir(),
		HomeDir: t.TempDir(),
		Session: guardrails.SessionState{PlanMode: true}, // plan mode blocks write tools
	}
	p := newTestProvider(env, &stdinWrites)

	// "write" is blocked in plan mode.
	ev := toolUseEvent("tool-001", "write", map[string]any{"path": "/tmp/foo.txt", "content": "hi"})
	events := runBridge(p, []claudecli.ClaudeEvent{ev})

	// Expect exactly one relay event: the tool_result_message error.
	if len(events) != 1 {
		t.Fatalf("expected 1 relay event, got %d: %v", len(events), events)
	}
	re := events[0]

	// Must be a tool_result_message with isError=true.
	if re["type"] != "tool_result_message" {
		t.Errorf("expected type=tool_result_message, got %v", re["type"])
	}
	if re["isError"] != true {
		t.Errorf("expected isError=true, got %v", re["isError"])
	}
	if re["toolCallId"] != "tool-001" {
		t.Errorf("expected toolCallId=tool-001, got %v", re["toolCallId"])
	}
	if re["toolName"] != "write" {
		t.Errorf("expected toolName=write, got %v", re["toolName"])
	}
	content, _ := re["content"].(string)
	if content == "" {
		t.Errorf("expected non-empty content (denial reason)")
	}
}

// TestDeniedToolCallWritesStdin verifies that when a tool call is denied,
// a tool_result error message is written to the subprocess stdin so Claude
// can respond to the blocked tool.
func TestDeniedToolCallWritesStdin(t *testing.T) {
	var stdinWrites [][]byte
	env := guardrails.EvalEnv{
		CWD:     t.TempDir(),
		HomeDir: t.TempDir(),
		Session: guardrails.SessionState{PlanMode: true},
	}
	p := newTestProvider(env, &stdinWrites)

	ev := toolUseEvent("tool-002", "edit", map[string]any{"path": "/tmp/bar.txt"})
	runBridge(p, []claudecli.ClaudeEvent{ev})

	if len(stdinWrites) != 1 {
		t.Fatalf("expected 1 stdin write, got %d", len(stdinWrites))
	}

	var msg map[string]any
	if err := json.Unmarshal(stdinWrites[0], &msg); err != nil {
		t.Fatalf("stdin write is not valid JSON: %v\nraw: %s", err, stdinWrites[0])
	}
	if msg["type"] != "tool_result" {
		t.Errorf("expected type=tool_result in stdin message, got %v", msg["type"])
	}
	if msg["tool_use_id"] != "tool-002" {
		t.Errorf("expected tool_use_id=tool-002, got %v", msg["tool_use_id"])
	}
	isError, _ := msg["is_error"].(bool)
	if !isError {
		t.Errorf("expected is_error=true in stdin message")
	}
}

// TestAllowedToolCallIsForwarded verifies that a tool call allowed by guardrails
// is forwarded normally through the adapter (produces a message_update relay event,
// not a tool_result_message error).
func TestAllowedToolCallIsForwarded(t *testing.T) {
	var stdinWrites [][]byte
	// ModeNone disables all sandbox enforcement → all tools allowed.
	env := guardrails.EvalEnv{
		CWD:     t.TempDir(),
		HomeDir: t.TempDir(),
		Config:  guardrails.SandboxConfig{Mode: guardrails.ModeNone},
	}
	p := newTestProvider(env, &stdinWrites)

	// "bash" with a safe read-only command should be allowed with ModeNone.
	ev := toolUseEvent("tool-003", "bash", map[string]any{"command": "echo hello"})
	events := runBridge(p, []claudecli.ClaudeEvent{ev})

	// Should not produce any tool_result_message errors.
	for _, re := range events {
		if re["type"] == "tool_result_message" && re["isError"] == true {
			t.Errorf("unexpected error relay event for allowed tool: %v", re)
		}
	}
	// Should produce at least one message_update (the adapter's output for tool_use).
	found := false
	for _, re := range events {
		if re["type"] == "message_update" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected message_update relay event for allowed tool, got: %v", events)
	}
	// No stdin writes should have been made.
	if len(stdinWrites) != 0 {
		t.Errorf("expected no stdin writes for allowed tool, got %d", len(stdinWrites))
	}
}

// TestToolUseEventNotForwardedWhenDenied verifies that when a tool is denied,
// no message_update (tool_use forwarding) event is emitted — only the error event.
func TestToolUseEventNotForwardedWhenDenied(t *testing.T) {
	var stdinWrites [][]byte
	env := guardrails.EvalEnv{
		CWD:     t.TempDir(),
		HomeDir: t.TempDir(),
		Session: guardrails.SessionState{PlanMode: true},
	}
	p := newTestProvider(env, &stdinWrites)

	ev := toolUseEvent("tool-004", "write_file", map[string]any{"path": "/tmp/x.txt"})
	events := runBridge(p, []claudecli.ClaudeEvent{ev})

	// Must not contain any message_update (that would mean the tool_use was forwarded).
	for _, re := range events {
		if re["type"] == "message_update" {
			t.Errorf("tool_use was forwarded as message_update despite being denied: %v", re)
		}
	}
	// Must contain exactly one tool_result_message error.
	errorCount := 0
	for _, re := range events {
		if re["type"] == "tool_result_message" && re["isError"] == true {
			errorCount++
		}
	}
	if errorCount != 1 {
		t.Errorf("expected 1 error relay event, got %d (all events: %v)", errorCount, events)
	}
}
