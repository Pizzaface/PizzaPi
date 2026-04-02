package claudewrapper

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
)

// RunnerConfig configures a Claude CLI subprocess.
type RunnerConfig struct {
	// Path to the claude binary (default: "claude")
	ClaudePath string
	// Working directory for the subprocess
	WorkDir string
	// Model to use (e.g. "claude-sonnet-4-20250514")
	Model string
	// Maximum turns
	MaxTurns int
	// System prompt to append
	SystemPrompt string
	// Session ID to resume (empty for new session)
	ResumeSessionID string
	// MCP config file path
	MCPConfig string
	// Additional CLI flags
	ExtraFlags []string
	// Environment variables to set (on top of inherited env)
	ExtraEnv []string
	// Stderr callback — called with each stderr line
	OnStderr func(line string)
}

// Runner manages a claude CLI subprocess lifecycle.
type Runner struct {
	config   RunnerConfig
	cmd      *exec.Cmd
	cancel   context.CancelFunc
	events   chan ClaudeEvent
	stderr   *strings.Builder
	done     chan struct{}
	mu       sync.Mutex
	exited   bool
	exitCode int
	exitErr  error
}

// NewRunner creates a Runner but does not start it.
func NewRunner(cfg RunnerConfig) *Runner {
	return &Runner{
		config:   cfg,
		exitCode: -1,
		stderr:   &strings.Builder{},
	}
}

// BuildArgs constructs the claude CLI argument list from config.
func (r *Runner) BuildArgs() []string {
	args := []string{
		"--print",
		"--output-format", "stream-json",
		"--verbose",
	}
	if r.config.Model != "" {
		args = append(args, "--model", r.config.Model)
	}
	if r.config.MaxTurns > 0 {
		args = append(args, "--max-turns", fmt.Sprintf("%d", r.config.MaxTurns))
	}
	if r.config.SystemPrompt != "" {
		args = append(args, "--append-system-prompt", r.config.SystemPrompt)
	}
	if r.config.ResumeSessionID != "" {
		args = append(args, "--resume", r.config.ResumeSessionID)
	}
	if r.config.MCPConfig != "" {
		args = append(args, "--mcp-config", r.config.MCPConfig)
	}
	args = append(args, r.config.ExtraFlags...)
	return args
}

// Start launches the claude subprocess and begins parsing stdout.
// Returns a channel of ClaudeEvents. The channel is closed when
// the process exits. Call Stop() or cancel the context to terminate.
func (r *Runner) Start(ctx context.Context, prompt string) (<-chan ClaudeEvent, error) {
	ctx, r.cancel = context.WithCancel(ctx)

	claudePath := r.config.ClaudePath
	if claudePath == "" {
		claudePath = "claude"
	}

	args := r.BuildArgs()
	args = append(args, "-p", prompt)

	r.cmd = exec.CommandContext(ctx, claudePath, args...)
	if r.config.WorkDir != "" {
		r.cmd.Dir = r.config.WorkDir
	}
	if len(r.config.ExtraEnv) > 0 {
		r.cmd.Env = append(r.cmd.Environ(), r.config.ExtraEnv...)
	}

	stdout, err := r.cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}

	stderrPipe, err := r.cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("stderr pipe: %w", err)
	}

	r.events = make(chan ClaudeEvent, 64)
	r.done = make(chan struct{})
	r.stderr = &strings.Builder{}
	r.exitCode = -1
	r.exited = false
	r.exitErr = nil

	if err := r.cmd.Start(); err != nil {
		close(r.events)
		close(r.done)
		r.mu.Lock()
		r.exited = true
		r.exitErr = fmt.Errorf("start: %w", err)
		r.mu.Unlock()
		return nil, fmt.Errorf("start: %w", err)
	}

	go func() {
		ParseStream(stdout, r.events)
	}()

	go r.collectStderr(stderrPipe)

	go func() {
		err := r.cmd.Wait()
		r.mu.Lock()
		r.exited = true
		r.exitErr = err
		if r.cmd.ProcessState != nil {
			r.exitCode = r.cmd.ProcessState.ExitCode()
		}
		r.mu.Unlock()
		close(r.done)
	}()

	return r.events, nil
}

func (r *Runner) collectStderr(pipe io.Reader) {
	scanner := bufio.NewScanner(pipe)
	for scanner.Scan() {
		line := scanner.Text()
		r.mu.Lock()
		if r.stderr.Len() > 0 {
			r.stderr.WriteByte('\n')
		}
		r.stderr.WriteString(line)
		r.mu.Unlock()
		if r.config.OnStderr != nil {
			r.config.OnStderr(line)
		}
	}
	if err := scanner.Err(); err != nil {
		r.mu.Lock()
		if r.stderr.Len() > 0 {
			r.stderr.WriteByte('\n')
		}
		r.stderr.WriteString(err.Error())
		r.mu.Unlock()
		if r.config.OnStderr != nil {
			r.config.OnStderr(err.Error())
		}
	}
}

// Stop gracefully stops the subprocess (SIGTERM, then wait).
func (r *Runner) Stop() error {
	if r.cancel != nil {
		r.cancel()
	}
	if r.done != nil {
		<-r.done
	}
		r.mu.Lock()
	defer r.mu.Unlock()
	return r.exitErr
}

// Done returns a channel that closes when the process exits.
func (r *Runner) Done() <-chan struct{} { return r.done }

// ExitCode returns the process exit code (-1 if not exited yet).
func (r *Runner) ExitCode() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.exitCode
}

// Stderr returns accumulated stderr output.
func (r *Runner) Stderr() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stderr.String()
}
