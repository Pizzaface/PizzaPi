package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"sync/atomic"

	claudewrapper "github.com/pizzaface/pizzapi/experimental/adk-go/claude-wrapper"
)

// ClaudeCLIProvider implements Provider by spawning a Claude Code CLI
// subprocess in interactive mode (--input-format stream-json).
//
// It owns the claude-wrapper Runner (subprocess lifecycle) and Adapter
// (NDJSON → RelayEvent translation). The go-runner never touches these
// directly — it only sees the Provider interface.
type ClaudeCLIProvider struct {
	runner  *claudewrapper.Runner
	adapter *claudewrapper.Adapter
	logger  *log.Logger

	events chan RelayEvent // relay events produced by this provider
	done   chan struct{}
	mu     sync.Mutex

	// Message queue fields
	followUpQueue chan string    // buffered channel for follow-up messages
	latestSteer   atomic.Pointer[string] // holds only the most recent steer (nil if none)

	// stateMu serialises the active-state transition + drain so that
	// concurrent QueueMessage calls cannot race with drainFollowUp.
	stateMu sync.Mutex
	active  atomic.Bool // true while processing a turn (SystemEvent → ResultEvent)
}

// NewClaudeCLIProvider creates a new Claude CLI provider.
func NewClaudeCLIProvider(logger *log.Logger) *ClaudeCLIProvider {
	return &ClaudeCLIProvider{
		adapter:       claudewrapper.NewAdapter(),
		logger:        logger,
		events:        make(chan RelayEvent, 128),
		done:          make(chan struct{}),
		followUpQueue: make(chan string, 64),
	}
}

// Start launches the claude subprocess in interactive mode and begins
// converting NDJSON events to RelayEvents on the returned channel.
func (p *ClaudeCLIProvider) Start(pctx ProviderContext) (<-chan RelayEvent, error) {
	cfg := claudewrapper.RunnerConfig{
		OnStderr: pctx.OnStderr,
	}
	if pctx.Cwd != "" {
		cfg.WorkDir = pctx.Cwd
	}
	if pctx.Model != "" {
		cfg.Model = pctx.Model
	}

	p.runner = claudewrapper.NewRunner(cfg)

	// Record the initial user prompt for message accumulation
	p.adapter.SetUserPrompt(pctx.Prompt)

	ctx := context.Background()
	// If we need cancellation, the caller uses Stop()

	rawEvents, err := p.runner.StartInteractive(ctx, pctx.Prompt)
	if err != nil {
		close(p.events)
		close(p.done)
		return nil, fmt.Errorf("start claude: %w", err)
	}

	// Bridge goroutine: reads claude-wrapper events, converts via adapter,
	// and pushes relay events to the output channel.
	go p.bridge(rawEvents)

	return p.events, nil
}

// bridge reads from the claude-wrapper event channel, converts each event
// to zero or more RelayEvents via the adapter, and sends them on p.events.
// It also:
//   - Sets active=true when a SystemEvent arrives (turn started)
//   - Sets active=false when a ResultEvent arrives (turn ended)
//   - After each ResultEvent, drains pending messages (steer first, then
//     follow-up) and sends the next one via SendMessage to start the next turn
func (p *ClaudeCLIProvider) bridge(rawEvents <-chan claudewrapper.ClaudeEvent) {
	defer func() {
		// Log any messages that will be dropped when the bridge exits.
		remaining := len(p.followUpQueue)
		if remaining > 0 {
			p.logger.Printf("bridge exit: dropping %d queued follow-up message(s)", remaining)
		}
		if p.latestSteer.Load() != nil {
			p.logger.Printf("bridge exit: dropping queued steer message")
		}
		close(p.events)
		close(p.done)
	}()

	for ev := range rawEvents {
		// Track turn state
		switch ev.(type) {
		case *claudewrapper.SystemEvent:
			p.active.Store(true)
		case *claudewrapper.ResultEvent:
			// Hold stateMu across the active→false transition and the drain so
			// that a concurrent QueueMessage cannot observe active=false and
			// take the direct-send path before we drain queued messages.
			p.stateMu.Lock()
			p.active.Store(false)
			relayEvents := p.adapter.HandleEvent(ev)
			for _, re := range relayEvents {
				p.events <- re
			}
			p.drainFollowUpLocked()
			p.stateMu.Unlock()
			continue
		}

		relayEvents := p.adapter.HandleEvent(ev)
		for _, re := range relayEvents {
			p.events <- re
		}
	}
}

// drainFollowUpLocked checks for the next message to send after a turn ends.
// It prefers a pending steer over queued follow-ups (steer is more urgent).
// Caller MUST hold stateMu.
func (p *ClaudeCLIProvider) drainFollowUpLocked() {
	// Steer takes priority — consume and clear the atomic pointer.
	if ptr := p.latestSteer.Swap(nil); ptr != nil {
		text := *ptr
		p.logger.Printf("follow-up drain: sending latest steer")
		if err := p.sendMessageInternal(text); err != nil {
			p.logger.Printf("follow-up drain: steer send error: %v", err)
		}
		return
	}

	// No steer — try the follow-up queue.
	select {
	case text := <-p.followUpQueue:
		p.logger.Printf("follow-up drain: sending queued message")
		if err := p.sendMessageInternal(text); err != nil {
			p.logger.Printf("follow-up drain: send error: %v", err)
		}
	default:
		// Queue is empty — nothing to drain
	}
}

// sendMessageInternal writes a message to the subprocess stdin.
// It does NOT update the adapter user prompt to avoid double-recording
// when called from bridge. Callers that need prompt tracking should use
// SendMessage instead.
func (p *ClaudeCLIProvider) sendMessageInternal(text string) error {
	msg := map[string]any{
		"type": "user",
		"message": map[string]any{
			"role":    "user",
			"content": text,
		},
	}
	msgBytes, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal user message: %w", err)
	}
	msgBytes = append(msgBytes, '\n')

	p.mu.Lock()
	defer p.mu.Unlock()
	if p.runner == nil {
		return fmt.Errorf("provider not started")
	}
	return p.runner.WriteStdin(msgBytes)
}

// SendMessage sends a user follow-up to the running claude subprocess.
// The message is formatted as NDJSON and written to stdin.
func (p *ClaudeCLIProvider) SendMessage(text string) error {
	// Record in adapter for state tracking
	p.adapter.SetUserPrompt(text)
	return p.sendMessageInternal(text)
}

// QueueMessage enqueues a message for delivery according to its priority.
//
// FollowUp messages are placed on followUpQueue and delivered after the
// current turn completes (auto-drained in bridge after each ResultEvent).
//
// Steer messages store only the latest steer via an atomic pointer.
// Only one steer is ever pending — each new steer overwrites the last.
// When the bridge drains after a ResultEvent, it delivers the steer
// (if any) before any follow-ups.
//
// P2 note: Steer returns an error when called idle and SendMessage fails.
func (p *ClaudeCLIProvider) QueueMessage(msg QueuedMessage) error {
	switch msg.Priority {
	case Steer:
		// Hold stateMu so we don't race with the bridge's active→false
		// transition + drain (P1 fix #2).
		p.stateMu.Lock()
		defer p.stateMu.Unlock()

		if !p.active.Load() {
			// Not active — deliver immediately
			p.logger.Printf("steer (idle): delivering immediately")
			return p.SendMessage(msg.Text)
		}
		// Active — Phase 0: store as latest steer only (P1 fix #1).
		// Overwrites any previous pending steer — only the latest matters.
		p.logger.Printf("steer (active, Phase 0): storing as latest steer")
		text := msg.Text
		p.latestSteer.Store(&text)
		return nil

	case FollowUp:
		// Hold stateMu so we don't race with the bridge's active→false
		// transition + drain (P1 fix #2).
		p.stateMu.Lock()
		defer p.stateMu.Unlock()

		if !p.active.Load() {
			// Not active — deliver immediately
			p.logger.Printf("follow-up (idle): delivering immediately")
			return p.SendMessage(msg.Text)
		}
		// Active — enqueue for post-result delivery
		select {
		case p.followUpQueue <- msg.Text:
			p.logger.Printf("follow-up (active): queued (depth=%d)", len(p.followUpQueue))
		default:
			return fmt.Errorf("follow-up queue full")
		}
		return nil

	default:
		return fmt.Errorf("unknown message priority: %d", msg.Priority)
	}
}

// IsActive reports whether the provider is currently processing a turn.
func (p *ClaudeCLIProvider) IsActive() bool {
	return p.active.Load()
}

// Done returns a channel that closes when the claude process exits.
func (p *ClaudeCLIProvider) Done() <-chan struct{} {
	return p.done
}

// ExitCode returns the claude process exit code.
func (p *ClaudeCLIProvider) ExitCode() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.runner == nil {
		return -1
	}
	return p.runner.ExitCode()
}

// Stop terminates the claude subprocess.
func (p *ClaudeCLIProvider) Stop() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.runner == nil {
		return nil
	}
	return p.runner.Stop()
}

// ModelMap returns the current model info from the adapter.
func (p *ClaudeCLIProvider) ModelMap() map[string]any {
	return p.adapter.ModelMap()
}
