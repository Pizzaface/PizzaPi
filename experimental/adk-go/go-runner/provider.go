package main

// MessagePriority determines when a queued message is delivered.
type MessagePriority int

const (
	// FollowUp delivers the message after the current turn completes.
	FollowUp MessagePriority = iota
	// Steer interrupts the current turn and delivers the message immediately.
	// In Phase 0, Steer degrades to FollowUp (true SIGINT interruption is Phase 1).
	Steer
)

// QueuedMessage is a message waiting for delivery.
type QueuedMessage struct {
	Text     string
	Priority MessagePriority
}

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

	// QueueMessage enqueues a message for delivery according to its priority.
	// FollowUp messages are delivered after the current turn completes.
	// Steer messages interrupt the current turn (Phase 0: degrades to FollowUp).
	QueueMessage(msg QueuedMessage) error

	// IsActive reports whether the provider is currently processing a turn
	// (i.e. between a SystemEvent and a ResultEvent).
	IsActive() bool

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
}

// RelayEvent is a provider-agnostic event map ready for the PizzaPi relay
// event pipeline. All providers must produce events matching the relay's
// expected shapes (heartbeat, session_active, message_update, etc.).
type RelayEvent = map[string]any
