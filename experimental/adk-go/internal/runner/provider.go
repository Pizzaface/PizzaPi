// Package runner provides the Provider interface and implementations for
// driving LLM sessions. The TUI and daemon both use this package.
//
// Provider implementations handle process lifecycle, protocol translation,
// and event format conversion internally. Callers only see RelayEvents.
//
// Current implementations:
//   - ClaudeCLIProvider: Claude Code CLI subprocess via --input-format stream-json
//
// Future implementations:
//   - ADKProvider: ADK Go framework for Gemini, OpenAI, and other non-Claude models
package runner

import guardrails "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/guardrails"

// RelayEvent is a provider-agnostic event map ready for the PizzaPi relay
// event pipeline. All providers must produce events matching the relay's
// expected shapes (heartbeat, session_active, message_update, etc.).
type RelayEvent = map[string]any

// Provider drives an LLM session. Implementations handle process lifecycle,
// protocol translation, and event format conversion internally.
//
// The runner only interacts with this interface — it never touches
// provider-specific types (NDJSON, subprocess flags, API clients, etc.).
type Provider interface {
	// Start launches the provider session and returns a channel of relay events.
	// Events are provider-agnostic — the implementation converts its native
	// format (NDJSON, SSE, etc.) to RelayEvents internally.
	// The channel closes when the provider session ends.
	Start(ctx ProviderContext) (<-chan RelayEvent, error)

	// SendMessage sends a user follow-up message to the running session.
	// For subprocess providers, this writes to stdin.
	// For API providers, this sends a new request with conversation history.
	SendMessage(text string) error

	// Done returns a channel that closes when the provider session exits.
	Done() <-chan struct{}

	// ExitCode returns the process exit code (-1 if still running or N/A).
	ExitCode() int

	// Stop terminates the provider session gracefully.
	Stop() error
}

// ProviderContext carries the configuration a provider needs to start a session.
type ProviderContext struct {
	// Prompt is the initial user message.
	Prompt string
	// Cwd is the working directory for the session.
	Cwd string
	// Model is the requested model ID (e.g. "claude-sonnet-4-20250514").
	// Provider implementations map this to their native model identifiers.
	Model string
	// OnStderr is called with each line of stderr output (for logging).
	OnStderr func(string)

	// HomeDir is the user's home directory, used by guardrails for ~ expansion.
	HomeDir string
	// PlanMode indicates the session is in read-only plan mode.
	// When true, write tools (edit, write, subagent, etc.) are blocked.
	PlanMode bool
	// SandboxConfig is the sandbox configuration passed to guardrails.
	SandboxConfig guardrails.SandboxConfig
}

// ProviderFactory creates a new Provider instance. Used by the registry.
type ProviderFactory func() Provider
