package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	claudecli "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/providers/claudecli"
	guardrails "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/guardrails"
)

// ClaudeCLIProvider implements Provider by spawning a Claude Code CLI
// subprocess in interactive mode (--input-format stream-json).
//
// It owns the claude-wrapper Runner (subprocess lifecycle) and Adapter
// (NDJSON → RelayEvent translation). The go-runner never touches these
// directly — it only sees the Provider interface.
type ClaudeCLIProvider struct {
	runner  *claudecli.Runner
	adapter *claudecli.Adapter
	logger  *log.Logger

	guardEnv    guardrails.EvalEnv // guardrails evaluation environment
	stdinWriter func([]byte) error  // writes to the claude subprocess stdin; injectable for tests

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

	p.runner = claudecli.NewRunner(cfg)

	// Build the guardrails evaluation environment from the provider context.
	p.guardEnv = guardrails.EvalEnv{
		CWD:     pctx.Cwd,
		HomeDir: pctx.HomeDir,
		Session: guardrails.SessionState{PlanMode: pctx.PlanMode},
		Config:  pctx.SandboxConfig,
	}

	// Wire up the real stdin writer.
	p.stdinWriter = p.runner.WriteStdin

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
//
// ToolUseEvents are evaluated against guardrails before forwarding.
// If a tool call is denied:
//   - A tool_result error is written to the claude subprocess stdin so Claude
//     knows the tool was blocked and can respond accordingly.
//   - A tool_result_message relay event with isError=true is emitted to the
//     relay so the web UI can display the denial.
//   - The original tool_use relay event is NOT forwarded.
func (p *ClaudeCLIProvider) bridge(rawEvents <-chan claudecli.ClaudeEvent) {
	defer close(p.events)
	defer close(p.done)

	for ev := range rawEvents {
		if toolUse, ok := ev.(*claudecli.ToolUseEvent); ok {
			if denied, errEvent := p.interceptToolUse(toolUse); denied {
				if errEvent != nil {
					p.events <- errEvent
				}
				continue // do NOT forward tool_use to relay
			}
		}

		relayEvents := p.adapter.HandleEvent(ev)
		for _, re := range relayEvents {
			p.events <- re
		}
	}
}

// interceptToolUse evaluates a tool_use event against the active guardrails.
// Returns (true, errorRelayEvent) if the call is denied and should be blocked,
// or (false, nil) if the call is allowed and should be forwarded normally.
func (p *ClaudeCLIProvider) interceptToolUse(e *claudecli.ToolUseEvent) (bool, RelayEvent) {
	// Parse the tool input JSON into a map for the guardrails evaluator.
	var args map[string]any
	if len(e.Input) > 0 {
		if err := json.Unmarshal(e.Input, &args); err != nil {
			args = map[string]any{}
		}
	}

	call := guardrails.ToolCall{Name: e.Name, Args: args}
	decision := guardrails.EvaluateToolCall(call, p.guardEnv)
	if decision.Allowed {
		return false, nil
	}

	p.logger.Printf("[guardrails] denied tool %q (id=%s): %s", e.Name, e.ToolID, decision.Reason)

	// Write a tool_result error back to the claude subprocess stdin so it
	// knows the tool was blocked and can respond to the user.
	toolResultMsg := map[string]any{
		"type":        "tool_result",
		"tool_use_id": e.ToolID,
		"content":     "Error: " + decision.Reason,
		"is_error":    true,
	}
	if msgBytes, err := json.Marshal(toolResultMsg); err == nil {
		msgBytes = append(msgBytes, '\n')
		if p.stdinWriter != nil {
			if err := p.stdinWriter(msgBytes); err != nil {
				p.logger.Printf("[guardrails] failed to write tool_result to stdin: %v", err)
			}
		}
	}

	// Emit a tool_result_message relay event so the web UI shows the denial.
	errEvent := RelayEvent{
		"type":       "tool_result_message",
		"role":       "tool_result",
		"toolCallId": e.ToolID,
		"toolName":   e.Name,
		"content":    "Error: " + decision.Reason,
		"isError":    true,
		"timestamp":  time.Now().UnixMilli(),
	}
	return true, errEvent
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
