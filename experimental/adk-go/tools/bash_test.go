package tools_test

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/tools"
)

func TestRunBash_SimpleCommand(t *testing.T) {
	result, err := tools.RunBash("echo hello", tools.BashOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ExitCode != 0 {
		t.Errorf("expected exit code 0, got %d", result.ExitCode)
	}
	if !strings.Contains(result.Output, "hello") {
		t.Errorf("expected output to contain 'hello', got %q", result.Output)
	}
	if result.TimedOut {
		t.Error("expected not timed out")
	}
	if result.Truncated {
		t.Error("expected not truncated")
	}
}

func TestRunBash_CwdRespected(t *testing.T) {
	dir := t.TempDir()
	result, err := tools.RunBash("pwd", tools.BashOpts{Cwd: dir})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ExitCode != 0 {
		t.Errorf("expected exit code 0, got %d", result.ExitCode)
	}
	// Resolve symlinks on both sides to handle macOS /private/tmp → /tmp.
	got, err := filepath.EvalSymlinks(strings.TrimSpace(result.Output))
	if err != nil {
		t.Fatalf("EvalSymlinks on pwd output: %v", err)
	}
	want, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("EvalSymlinks on expected dir: %v", err)
	}
	if got != want {
		t.Errorf("pwd output: %q, expected dir: %q", got, want)
	}
}

func TestRunBash_Timeout(t *testing.T) {
	result, err := tools.RunBash("sleep 60", tools.BashOpts{Timeout: 200 * time.Millisecond})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.TimedOut {
		t.Error("expected TimedOut = true")
	}
	if result.ExitCode == 0 {
		t.Error("expected non-zero exit code after timeout")
	}
}

func TestRunBash_NonZeroExitCode(t *testing.T) {
	result, err := tools.RunBash("exit 42", tools.BashOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ExitCode != 42 {
		t.Errorf("expected exit code 42, got %d", result.ExitCode)
	}
}

func TestRunBash_StderrIncluded(t *testing.T) {
	result, err := tools.RunBash("echo 'stdout line' && echo 'stderr line' >&2", tools.BashOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result.Output, "stdout line") {
		t.Errorf("expected output to contain stdout, got %q", result.Output)
	}
	if !strings.Contains(result.Output, "stderr line") {
		t.Errorf("expected output to contain stderr, got %q", result.Output)
	}
}

func TestRunBash_OutputTruncation(t *testing.T) {
	// Generate 2500 lines to exceed the 2000-line limit
	// Each line: "line NNNN"
	var sb strings.Builder
	for i := 1; i <= 2500; i++ {
		fmt.Fprintf(&sb, "echo 'line %04d'\n", i)
	}
	result, err := tools.RunBash(sb.String(), tools.BashOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Truncated {
		t.Error("expected Truncated = true")
	}
	lines := strings.Split(strings.TrimRight(result.Output, "\n"), "\n")
	if len(lines) > 2000 {
		t.Errorf("expected at most 2000 lines, got %d", len(lines))
	}
	// Tail should be preserved: last lines should be from the end
	lastLine := lines[len(lines)-1]
	if !strings.Contains(lastLine, "2500") {
		t.Errorf("expected last line to contain '2500' (tail kept), got %q", lastLine)
	}
}

func TestRunBash_DefaultTimeout(t *testing.T) {
	// A quick command should complete well before the 120s default timeout.
	start := time.Now()
	result, err := tools.RunBash("echo done", tools.BashOpts{})
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.TimedOut {
		t.Error("expected not timed out")
	}
	if elapsed > 10*time.Second {
		t.Errorf("simple command took too long: %v", elapsed)
	}
}

// TestRunBash_BackgroundProcessTimeout is a regression test for the deadlock
// where a command spawning background processes caused RunBash to hang forever
// on timeout. The background process held the pipe open, blocking cmd.Wait(),
// so the process-group SIGKILL (which was ordered after the drain) never ran.
//
// Fix: kill the process group BEFORE draining the done channel on timeout.
func TestRunBash_BackgroundProcessTimeout(t *testing.T) {
	start := time.Now()
	// "sleep 999 &" spawns a background process that holds the pipe open.
	// "echo started" prints before bash exits.
	// Without the fix, RunBash hangs indefinitely waiting for the pipe to close.
	result, err := tools.RunBash("sleep 999 & echo started", tools.BashOpts{Timeout: 500 * time.Millisecond})
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if elapsed > 2*time.Second {
		t.Errorf("RunBash deadlocked: took %v, expected < 2s (background process held pipe open)", elapsed)
	}
	if !result.TimedOut {
		t.Error("expected TimedOut = true")
	}
	if !strings.Contains(result.Output, "started") {
		t.Errorf("expected output to contain 'started' (echo ran before timeout), got %q", result.Output)
	}
}

func TestRunBash_ByteTruncation(t *testing.T) {
	// Generate output that exceeds 50KB: 600 lines of 100 'A's each
	line := strings.Repeat("A", 100)
	cmd := fmt.Sprintf("for i in $(seq 1 600); do echo '%s'; done", line)
	result, err := tools.RunBash(cmd, tools.BashOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Truncated {
		t.Error("expected Truncated = true due to byte limit")
	}
	if len(result.Output) > 50*1024 {
		t.Errorf("expected output <= 50KB, got %d bytes", len(result.Output))
	}
}
