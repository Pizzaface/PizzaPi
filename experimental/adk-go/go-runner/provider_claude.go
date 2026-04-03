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
	steerCh       chan string    // channel for steer messages (capacity 1 — only latest matters)
	active        atomic.Bool   // true while processing a turn (SystemEvent → ResultEvent)
}

// NewClaudeCLIProvider creates a new Claude CLI provider.
func NewClaudeCLIProvider(logger *log.Logger) *ClaudeCLIProvider {
	return &ClaudeCLIProvider{
		adapter:       claudewrapper.NewAdapter(),
		logger:        logger,
		events:        make(chan RelayEvent, 128),
		done:          make(chan struct{}),
		followUpQueue: make(chan string, 64),
		steerCh:       make(chan string, 1),
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
//   - After each ResultEvent, drains one follow-up from followUpQueue and
//     sends it via SendMessage to automatically start the next turn
func (p *ClaudeCLIProvider) bridge(rawEvents <-chan claudewrapper.ClaudeEvent) {
	defer close(p.events)
	defer close(p.done)

	for ev := range rawEvents {
		// Track turn state
		switch ev.(type) {
		case *claudewrapper.SystemEvent:
			p.active.Store(true)
		case *claudewrapper.ResultEvent:
			p.active.Store(false)
		}

		relayEvents := p.adapter.HandleEvent(ev)
		for _, re := range relayEvents {
			p.events <- re
		}

		// After ResultEvent: drain one follow-up message to start next turn
		if _, ok := ev.(*claudewrapper.ResultEvent); ok {
			p.drainFollowUp()
		}
	}
}

// drainFollowUp checks followUpQueue (non-blocking) and delivers the next
// message if one is available. Called after each ResultEvent.
func (p *ClaudeCLIProvider) drainFollowUp() {
	select {
	case text := <-p.followUpQueue:
		p.logger.Printf("follow-up drain: sending queued message")
		if err := p.SendMessage(text); err != nil {
			p.logger.Printf("follow-up drain: send error: %v", err)
		}
	default:
		// Queue is empty — nothing to drain
	}
}

// SendMessage sends a user follow-up to the running claude subprocess.
// The message is formatted as NDJSON and written to stdin.
func (p *ClaudeCLIProvider) SendMessage(text string) error {
	// Record in adapter for state tracking
	p.adapter.SetUserPrompt(text)

	// Format as Claude CLI stdin NDJSON
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

// QueueMessage enqueues a message for delivery according to its priority.
//
// FollowUp messages are placed on followUpQueue and delivered after the
// current turn completes (auto-drained in bridge after each ResultEvent).
//
// Steer messages are intended to interrupt the current turn. In Phase 0,
// steer degrades to follow-up: the message is placed on steerCh (capacity 1,
// so only the latest steer is retained) and will be drained on next idle.
// True mid-turn SIGINT interruption is Phase 1.
func (p *ClaudeCLIProvider) QueueMessage(msg QueuedMessage) error {
	switch msg.Priority {
	case Steer:
		if !p.active.Load() {
			// Not active — deliver immediately
			p.logger.Printf("steer (idle): delivering immediately")
			return p.SendMessage(msg.Text)
		}
		// Active — Phase 0: degrade to follow-up via steerCh (keep only latest)
		p.logger.Printf("steer (active, Phase 0): degrading to follow-up")
		// Drain any existing steer so we can insert the new (latest) one
		select {
		case <-p.steerCh:
		default:
		}
		// Insert onto steerCh. Also push to followUpQueue so bridge can drain it.
		select {
		case p.steerCh <- msg.Text:
		default:
		}
		select {
		case p.followUpQueue <- msg.Text:
		default:
			p.logger.Printf("steer degrade: followUpQueue full, message dropped")
		}
		return nil

	case FollowUp:
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
