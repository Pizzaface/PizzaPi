package tools

import (
	"bytes"
	"context"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

const (
	defaultTimeout  = 120 * time.Second
	maxBashLines    = 2000
	maxBashBytes    = 50 * 1024 // 50KB
)

// BashOpts controls how RunBash executes a command.
type BashOpts struct {
	// Timeout is the maximum time to wait for the command to finish.
	// Zero means use the default timeout of 120 seconds.
	Timeout time.Duration
	// Cwd is the working directory for the command.
	// Empty means the current working directory.
	Cwd string
}

// BashResult holds the result of a RunBash call.
type BashResult struct {
	// Output is the combined stdout+stderr of the command.
	// When truncated, only the tail is kept.
	Output string
	// ExitCode is the exit code of the command.
	ExitCode int
	// Truncated is true if the output was cut short due to line/byte limits.
	Truncated bool
	// TimedOut is true if the command was killed due to timeout.
	TimedOut bool
}

// RunBash executes command via `bash -c` and returns the combined output.
// Output is truncated to the last 2000 lines or 50KB, whichever hits first.
// The process group is killed on timeout to clean up child processes.
func RunBash(command string, opts BashOpts) (BashResult, error) {
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "bash", "-c", command)
	if opts.Cwd != "" {
		cmd.Dir = opts.Cwd
	}

	// Run in its own process group so we can kill the whole group on timeout.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf

	timedOut := false

	if err := cmd.Start(); err != nil {
		return BashResult{}, err
	}

	// Wait for the command, watching for context cancellation.
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	select {
	case <-ctx.Done():
		timedOut = true
		// Kill the entire process group.
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		<-done // drain
	case <-done:
		// Command finished normally.
	}

	exitCode := 0
	if cmd.ProcessState != nil {
		exitCode = cmd.ProcessState.ExitCode()
		if exitCode < 0 {
			exitCode = 1 // killed / signaled
		}
	}

	output, truncated := truncateTail(buf.String())

	return BashResult{
		Output:    output,
		ExitCode:  exitCode,
		Truncated: truncated,
		TimedOut:  timedOut,
	}, nil
}

// truncateTail keeps the LAST maxBashLines lines (or maxBashBytes bytes),
// whichever limit is hit first, and returns whether truncation occurred.
func truncateTail(output string) (string, bool) {
	if len(output) == 0 {
		return output, false
	}

	// Split into lines while preserving newlines.
	lines := splitLines(output)

	// Apply line limit: keep last maxBashLines lines.
	if len(lines) > maxBashLines {
		lines = lines[len(lines)-maxBashLines:]
		// After trimming by line, apply byte limit too.
		result := joinLines(lines)
		if len(result) > maxBashBytes {
			result = result[len(result)-maxBashBytes:]
		}
		return result, true
	}

	// Apply byte limit: keep last maxBashBytes bytes.
	joined := joinLines(lines)
	if len(joined) > maxBashBytes {
		return joined[len(joined)-maxBashBytes:], true
	}

	return joined, false
}

// splitLines splits a string into lines, preserving the trailing newline on each.
func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	var lines []string
	remaining := s
	for {
		idx := strings.IndexByte(remaining, '\n')
		if idx < 0 {
			// No more newlines — trailing fragment without newline.
			if remaining != "" {
				lines = append(lines, remaining)
			}
			break
		}
		lines = append(lines, remaining[:idx+1])
		remaining = remaining[idx+1:]
	}
	return lines
}

// joinLines concatenates a slice of lines back into a single string.
func joinLines(lines []string) string {
	return strings.Join(lines, "")
}


