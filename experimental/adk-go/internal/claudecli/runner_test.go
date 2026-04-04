package claudecli

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestBuildArgsBasic(t *testing.T) {
	r := NewRunner(RunnerConfig{})
	args := r.BuildArgs()

	expectedPrefix := []string{"--print", "--output-format", "stream-json", "--verbose"}
	if len(args) != len(expectedPrefix) {
		t.Fatalf("expected %d args, got %d: %v", len(expectedPrefix), len(args), args)
	}
	if !reflect.DeepEqual(args, expectedPrefix) {
		t.Fatalf("unexpected args: got %v want %v", args, expectedPrefix)
	}
	for _, forbidden := range []string{"--model", "--max-turns", "--resume", "--append-system-prompt", "--mcp-config"} {
		for _, arg := range args {
			if arg == forbidden {
				t.Fatalf("did not expect %q in args: %v", forbidden, args)
			}
		}
	}
}

func TestBuildArgsFull(t *testing.T) {
	r := NewRunner(RunnerConfig{
		Model:           "claude-sonnet-4-20250514",
		MaxTurns:        10,
		SystemPrompt:    "You are helpful",
		ResumeSessionID: "sess_123",
		MCPConfig:       "/tmp/mcp.json",
		ExtraFlags:      []string{"--no-session-persistence"},
	})

	args := r.BuildArgs()
	expected := []string{
		"--print",
		"--output-format", "stream-json",
		"--verbose",
		"--model", "claude-sonnet-4-20250514",
		"--max-turns", "10",
		"--append-system-prompt", "You are helpful",
		"--resume", "sess_123",
		"--mcp-config", "/tmp/mcp.json",
		"--no-session-persistence",
	}

	if !reflect.DeepEqual(args, expected) {
		t.Fatalf("unexpected args:\n got: %v\nwant: %v", args, expected)
	}
}

func TestRunnerWorkDir(t *testing.T) {
	r := NewRunner(RunnerConfig{WorkDir: "/tmp/test"})
	if r.config.WorkDir != "/tmp/test" {
		t.Fatalf("unexpected WorkDir: %q", r.config.WorkDir)
	}
}

func TestRunnerStartWithEcho(t *testing.T) {
	r := NewRunner(RunnerConfig{ClaudePath: "echo", ExtraFlags: []string{}})
	if r.config.ClaudePath != "echo" {
		t.Fatalf("unexpected ClaudePath: %q", r.config.ClaudePath)
	}
	args := r.BuildArgs()
	if len(args) < 4 || args[0] != "--print" || args[1] != "--output-format" || args[2] != "stream-json" || args[3] != "--verbose" {
		t.Fatalf("unexpected args: %v", args)
	}
}

func TestRunnerWithFakeProcess(t *testing.T) {
	script := `printf '{"type":"system","session_id":"test","tools":[],"cwd":"/tmp","model":"test"}\n{"type":"result","session_id":"test","cost_usd":0.01,"duration_secs":1.0,"usage":{"input_tokens":10,"output_tokens":5}}\n'`

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	r := NewRunner(RunnerConfig{ClaudePath: "bash"})
	if r.config.ClaudePath != "bash" {
		t.Fatalf("unexpected ClaudePath: %q", r.config.ClaudePath)
	}

	cmdCtx, cmdCancel := context.WithTimeout(ctx, 5*time.Second)
	defer cmdCancel()

	cmd := exec.CommandContext(cmdCtx, "bash", "-c", script)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}

	events := make(chan ClaudeEvent, 64)
	go ParseStream(stdout, events)

	var received []ClaudeEvent
	for ev := range events {
		received = append(received, ev)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("wait: %v", err)
	}

	if len(received) != 2 {
		t.Fatalf("expected 2 events, got %d", len(received))
	}
	if received[0].EventType() != "system" {
		t.Fatalf("first event type = %q", received[0].EventType())
	}
	if received[1].EventType() != "result" {
		t.Fatalf("second event type = %q", received[1].EventType())
	}
}

func TestRunnerStderrCollection(t *testing.T) {
	tmpDir := t.TempDir()
	scriptPath := filepath.Join(tmpDir, "fake-claude.sh")
	script := strings.Join([]string{
		"#!/bin/sh",
		"echo '{\"type\":\"system\",\"session_id\":\"t\",\"tools\":[],\"cwd\":\"/\",\"model\":\"m\"}'",
		"echo 'debug info' >&2",
	}, "\n") + "\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write script: %v", err)
	}

	var stderrLines []string
	r := NewRunner(RunnerConfig{
		ClaudePath: scriptPath,
		OnStderr: func(line string) {
			stderrLines = append(stderrLines, line)
		},
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	events, err := r.Start(ctx, "ignored")
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	var received []ClaudeEvent
	for ev := range events {
		received = append(received, ev)
	}
	<-r.Done()

	if len(received) != 1 {
		t.Fatalf("expected 1 event, got %d", len(received))
	}
	if received[0].EventType() != "system" {
		t.Fatalf("unexpected event type: %q", received[0].EventType())
	}
	if got := r.Stderr(); !strings.Contains(got, "debug info") {
		t.Fatalf("stderr missing debug info: %q", got)
	}
	if len(stderrLines) != 1 || stderrLines[0] != "debug info" {
		t.Fatalf("unexpected stderr callback lines: %v", stderrLines)
	}
}

func TestRunnerContextCancellation(t *testing.T) {
	tmpDir := t.TempDir()
	scriptPath := filepath.Join(tmpDir, "sleepy-claude.sh")
	script := strings.Join([]string{
		"#!/bin/sh",
		"trap 'exit 0' TERM INT",
		"echo '{\"type\":\"system\",\"session_id\":\"cancel\",\"tools\":[],\"cwd\":\"/tmp\",\"model\":\"test\"}'",
		"sleep 60",
	}, "\n") + "\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write script: %v", err)
	}

	r := NewRunner(RunnerConfig{ClaudePath: scriptPath})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	events, err := r.Start(ctx, "ignored")
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	select {
	case ev, ok := <-events:
		if !ok {
			t.Fatal("events channel closed before first event")
		}
		if ev.EventType() != "system" {
			t.Fatalf("unexpected first event type: %q", ev.EventType())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for first event")
	}

	time.Sleep(100 * time.Millisecond)
	cancel()

	select {
	case <-r.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for runner to exit after cancellation")
	}

	for range events {
	}

	if err := r.Stop(); err != nil && !strings.Contains(err.Error(), "killed") && !strings.Contains(err.Error(), "signal: terminated") && !strings.Contains(err.Error(), "context canceled") {
		t.Fatalf("unexpected stop error: %v", err)
	}
}
