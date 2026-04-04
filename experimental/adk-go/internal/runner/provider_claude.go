package runner

import (
	"fmt"
	"log"
	"sync"

	guardrails "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/guardrails"
	adkprovider "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/providers/adk"
	claudecli "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/providers/claudecli"
)

// ClaudeCLIProvider keeps the external provider name (`claude-cli`) while
// delegating orchestration/session lifecycle to the shared ADK runtime.
// Claude-specific behavior now lives at the Claude-on-ADK boundary inside
// internal/providers/claudecli.
type ClaudeCLIProvider struct {
	logger  *log.Logger
	runtime *adkprovider.Runtime
	modelID string

	mu      sync.Mutex
	started bool
}

// NewClaudeCLIProvider creates a new Claude CLI provider.
func NewClaudeCLIProvider(logger *log.Logger) *ClaudeCLIProvider {
	if logger == nil {
		logger = log.Default()
	}
	return &ClaudeCLIProvider{logger: logger}
}

// Start launches the shared ADK runtime with a Claude-backed custom agent.
func (p *ClaudeCLIProvider) Start(pctx ProviderContext) (<-chan RelayEvent, error) {
	p.mu.Lock()
	if p.started {
		p.mu.Unlock()
		return nil, fmt.Errorf("provider already started")
	}
	p.started = true
	p.mu.Unlock()

	runnerCfg := claudecli.RunnerConfig{OnStderr: pctx.OnStderr}
	if pctx.Cwd != "" {
		runnerCfg.WorkDir = pctx.Cwd
	}
	if pctx.Model != "" {
		runnerCfg.Model = pctx.Model
	}

	agentImpl, err := claudecli.NewClaudeSessionAgent(claudecli.ClaudeSessionAgentConfig{
		Name:         "claude-cli",
		Description:  "Claude Code CLI session agent for PizzaPi",
		RunnerConfig: runnerCfg,
		GuardEnv:     guardrailsFromContext(pctx),
		Logger:       p.logger,
	})
	if err != nil {
		return nil, fmt.Errorf("create claude session agent: %w", err)
	}

	rt, err := adkprovider.NewRuntime(adkprovider.RuntimeConfig{
		AppName:            "pizzapi",
		ProviderName:       "claude-cli",
		ProviderLabel:      "anthropic",
		ModelID:            runnerCfg.Model,
		Cwd:                pctx.Cwd,
		Logger:             p.logger,
		Agent:              agentImpl,
		RelayAdapter:       claudecli.NewRuntimeRelayAdapter(),
		DisableTurnSummary: true,
	})
	if err != nil {
		return nil, err
	}
	p.runtime = rt
	p.modelID = runnerCfg.Model
	return p.runtime.Start(pctx.Prompt)
}

func (p *ClaudeCLIProvider) SendMessage(text string) error {
	p.mu.Lock()
	rt := p.runtime
	p.mu.Unlock()
	if rt == nil {
		return fmt.Errorf("provider not started")
	}
	return rt.SendMessage(text)
}

func (p *ClaudeCLIProvider) Done() <-chan struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.runtime == nil {
		ch := make(chan struct{})
		close(ch)
		return ch
	}
	return p.runtime.Done()
}

func (p *ClaudeCLIProvider) ExitCode() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.runtime == nil {
		return -1
	}
	return p.runtime.ExitCode()
}

func (p *ClaudeCLIProvider) Stop() error {
	p.mu.Lock()
	rt := p.runtime
	p.mu.Unlock()
	if rt == nil {
		return nil
	}
	return rt.Stop()
}

func (p *ClaudeCLIProvider) ModelMap() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	return map[string]any{"provider": "anthropic", "id": p.modelID}
}

func guardrailsFromContext(pctx ProviderContext) guardrails.EvalEnv {
	return guardrails.EvalEnv{
		CWD:     pctx.Cwd,
		HomeDir: pctx.HomeDir,
		Session: guardrails.SessionState{PlanMode: pctx.PlanMode},
		Config:  pctx.SandboxConfig,
	}
}
