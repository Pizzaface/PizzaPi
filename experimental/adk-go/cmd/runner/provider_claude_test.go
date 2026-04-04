package main

import (
	"encoding/json"
	"testing"

	guardrails "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/guardrails"
	claudecli "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/providers/claudecli"
	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/runner"
)

// toolUseEvent builds a ToolUseEvent with the given args marshalled as JSON.
func toolUseEvent(id, name string, args map[string]any) *claudecli.ToolUseEvent {
	raw, _ := json.Marshal(args)
	return &claudecli.ToolUseEvent{ToolID: id, Name: name, Input: raw}
}

// TestDeniedToolCallEmitsErrorEvent verifies that when a tool call is denied by
// guardrails, a tool_result_message relay event with isError=true is emitted.
func TestDeniedToolCallEmitsErrorEvent(t *testing.T) {
	var stdinWrites [][]byte
	env := guardrails.EvalEnv{
		CWD:     t.TempDir(),
		HomeDir: t.TempDir(),
		Session: guardrails.SessionState{PlanMode: true},
	}
	p := runner.NewTestClaudeCLIProvider(env, &stdinWrites)

	ev := toolUseEvent("tool-001", "write", map[string]any{"path": "/tmp/foo.txt", "content": "hi"})
	events := runner.RunBridge(p, env, &stdinWrites, []claudecli.ClaudeEvent{ev})

	if len(events) != 1 {
		t.Fatalf("expected 1 relay event, got %d: %v", len(events), events)
	}
	re := events[0]
	if re["type"] != "tool_result_message" {
		t.Errorf("expected type=tool_result_message, got %v", re["type"])
	}
	if re["isError"] != true {
		t.Errorf("expected isError=true, got %v", re["isError"])
	}
	if re["toolCallId"] != "tool-001" {
		t.Errorf("expected toolCallId=tool-001, got %v", re["toolCallId"])
	}
}

// TestDeniedToolCallWritesStdin verifies that a denial writes to stdin.
func TestDeniedToolCallWritesStdin(t *testing.T) {
	var stdinWrites [][]byte
	env := guardrails.EvalEnv{
		CWD:     t.TempDir(),
		HomeDir: t.TempDir(),
		Session: guardrails.SessionState{PlanMode: true},
	}
	p := runner.NewTestClaudeCLIProvider(env, &stdinWrites)

	ev := toolUseEvent("tool-002", "edit", map[string]any{"path": "/tmp/bar.txt"})
	runner.RunBridge(p, env, &stdinWrites, []claudecli.ClaudeEvent{ev})

	if len(stdinWrites) != 1 {
		t.Fatalf("expected 1 stdin write, got %d", len(stdinWrites))
	}
	var msg map[string]any
	if err := json.Unmarshal(stdinWrites[0], &msg); err != nil {
		t.Fatalf("stdin write not valid JSON: %v", err)
	}
	if msg["type"] != "tool_result" {
		t.Errorf("expected type=tool_result, got %v", msg["type"])
	}
	if msg["tool_use_id"] != "tool-002" {
		t.Errorf("expected tool_use_id=tool-002, got %v", msg["tool_use_id"])
	}
}

// TestAllowedToolCallIsForwarded verifies allowed tools are forwarded.
func TestAllowedToolCallIsForwarded(t *testing.T) {
	var stdinWrites [][]byte
	env := guardrails.EvalEnv{
		CWD:     t.TempDir(),
		HomeDir: t.TempDir(),
		Config:  guardrails.SandboxConfig{Mode: guardrails.ModeNone},
	}
	p := runner.NewTestClaudeCLIProvider(env, &stdinWrites)

	ev := toolUseEvent("tool-003", "bash", map[string]any{"command": "echo hello"})
	events := runner.RunBridge(p, env, &stdinWrites, []claudecli.ClaudeEvent{ev})

	for _, re := range events {
		if re["type"] == "tool_result_message" && re["isError"] == true {
			t.Errorf("unexpected error for allowed tool: %v", re)
		}
	}
	found := false
	for _, re := range events {
		if re["type"] == "message_update" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected message_update for allowed tool")
	}
	if len(stdinWrites) != 0 {
		t.Errorf("expected no stdin writes for allowed tool")
	}
}

// TestToolUseEventNotForwardedWhenDenied verifies no message_update for denied tools.
func TestToolUseEventNotForwardedWhenDenied(t *testing.T) {
	var stdinWrites [][]byte
	env := guardrails.EvalEnv{
		CWD:     t.TempDir(),
		HomeDir: t.TempDir(),
		Session: guardrails.SessionState{PlanMode: true},
	}
	p := runner.NewTestClaudeCLIProvider(env, &stdinWrites)

	ev := toolUseEvent("tool-004", "write_file", map[string]any{"path": "/tmp/x.txt"})
	events := runner.RunBridge(p, env, &stdinWrites, []claudecli.ClaudeEvent{ev})

	for _, re := range events {
		if re["type"] == "message_update" {
			t.Errorf("tool_use forwarded despite being denied: %v", re)
		}
	}
	errorCount := 0
	for _, re := range events {
		if re["type"] == "tool_result_message" && re["isError"] == true {
			errorCount++
		}
	}
	if errorCount != 1 {
		t.Errorf("expected 1 error event, got %d", errorCount)
	}
}
