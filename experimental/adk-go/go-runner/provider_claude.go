package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"

	claudecli "github.com/pizzaface/pizzapi/experimental/adk-go/providers/claudecli"
)

// ClaudeCLIProvider implements Provider by spawning a Claude Code CLI
// subprocess in interactive mode (--input-format stream-json).
//
// It owns the providers/claudecli Runner (subprocess lifecycle) and Adapter
// (NDJSON → RelayEvent translation). The go-runner never touches these
// directly — it only sees the Provider interface.
type ClaudeCLIProvider struct {
	runner  *claudecli.Runner
	adapter *claudecli.Adapter
	logger  *log.Logger

	events chan RelayEvent // relay events produced by this provider
	done   chan struct{}
	mu     sync.Mutex
}

// NewClaudeCLIProvider creates a new Claude CLI provider.
func NewClaudeCLIProvider(logger *log.Logger) *ClaudeCLIProvider {
	return &ClaudeCLIProvider{
		adapter: claudecli.NewAdapter(),
		logger:  logger,
		events:  make(chan RelayEvent, 128),
		done:    make(chan struct{}),
	}
}

// Start launches the claude subprocess in interactive mode and begins
// converting NDJSON events to RelayEvents on the returned channel.
func (p *ClaudeCLIProvider) Start(pctx ProviderContext) (<-chan RelayEvent, error) {
	cfg := claudecli.RunnerConfig{
		OnStderr: pctx.OnStderr,
	}
	if pctx.Cwd != "" {
		cfg.WorkDir = pctx.Cwd
	}
	if pctx.Model != "" {
		cfg.Model = pctx.Model
	}
	if pctx.SystemPrompt != "" {
		cfg.SystemPrompt = pctx.SystemPrompt
	}
	if pctx.MCPConfigPath != "" {
		cfg.MCPConfig = pctx.MCPConfigPath
	}

	p.runner = claudecli.NewRunner(cfg)

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

	// Bridge goroutine: reads providers/claudecli events, converts via adapter,
	// and pushes relay events to the output channel.
	go p.bridge(rawEvents)

	return p.events, nil
}

// bridge reads from the providers/claudecli event channel, converts each event
// to zero or more RelayEvents via the adapter, and sends them on p.events.
func (p *ClaudeCLIProvider) bridge(rawEvents <-chan claudecli.ClaudeEvent) {
	defer close(p.events)
	defer close(p.done)

	for ev := range rawEvents {
		relayEvents := p.adapter.HandleEvent(ev)
		for _, re := range relayEvents {
			p.events <- re
		}
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
