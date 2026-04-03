package main

// Provider drives an LLM session. Implementations handle process lifecycle,
// protocol translation, and event format conversion internally.
//
// The go-runner only interacts with this interface — it never touches
// provider-specific types (NDJSON, subprocess flags, API clients, etc.).
//
// Current implementations:
//   - ClaudeCLIProvider: Claude Code CLI subprocess via --input-format stream-json
//
// Future implementations:
//   - AnthropicAPIProvider: direct Anthropic Messages API (streaming SSE)
//   - OpenAIProvider: OpenAI Chat Completions API
//   - GoogleProvider: Gemini API
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

	// SetActiveHeartbeat emits an active=true heartbeat through the relay.
	// Called by the runner when user input arrives (before SendMessage).
	// Providers can also emit heartbeats internally through the event channel.

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
	// May be empty when resuming an existing session.
	Prompt string
	// Cwd is the working directory for the session.
	Cwd string
	// Model is the requested model ID (e.g. "claude-sonnet-4-20250514").
	// Provider implementations map this to their native model identifiers.
	Model string
	// ResumeID is the Claude session ID to resume (passed as --resume <id>).
	// When set, the provider resumes an existing conversation.
	// Prompt may be empty when ResumeID is set.
	ResumeID string
	// ResumePath is a path to a session file to resume from.
	// Used as a fallback if ResumeID is not available.
	ResumePath string
	// OnStderr is called with each line of stderr output (for logging).
	OnStderr func(string)
}

// RelayEvent is a provider-agnostic event map ready for the PizzaPi relay
// event pipeline. All providers must produce events matching the relay's
// expected shapes (heartbeat, session_active, message_update, etc.).
type RelayEvent = map[string]any
