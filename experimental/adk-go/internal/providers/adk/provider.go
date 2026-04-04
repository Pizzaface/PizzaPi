package adk

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/model"
	"google.golang.org/adk/runner"
	"google.golang.org/adk/session"
	"google.golang.org/adk/tool"
	"google.golang.org/genai"


)

// BackendConfig defines the configuration for a specific model backend.
// Each registered provider (gemini, openai, etc.) has its own BackendConfig.
type BackendConfig struct {
	// Name is the registry name (e.g. "gemini", "openai", "mistral").
	Name string

	// Provider is the display provider name (e.g. "google", "openai", "mistral").
	Provider string

	// DefaultModel is the model to use when none is specified
	// (e.g. "gemini-2.5-flash", "gpt-4o", "mistral-large-latest").
	DefaultModel string

	// APIKeyEnvVar is the environment variable name for the API key
	// (e.g. "GOOGLE_API_KEY", "OPENAI_API_KEY", "MISTRAL_API_KEY").
	APIKeyEnvVar string

	// NewModel creates the ADK model.LLM for this backend.
	// The apiKey and modelName are resolved from config/env.
	NewModel func(ctx context.Context, modelName, apiKey string) (model.LLM, error)

	// Instruction is the system instruction for the agent.
	// If empty, a sensible default is used.
	Instruction string
}



// Provider implements the PizzaPi runner.Provider interface using ADK Go.
// It is configured via BackendConfig for a specific model backend.
type Provider struct {
	config  BackendConfig
	logger  *log.Logger
	adapter *Adapter

	adkRunner *runner.Runner
	sessionID string
	userID    string
	sessionSvc session.Service

	events chan RelayEvent
	done   chan struct{}
	cancel context.CancelFunc

	mu      sync.Mutex
	started bool
}

// NewProvider creates a new ADK-backed provider with the given backend config.
func NewProvider(config BackendConfig, logger *log.Logger) *Provider {
	if logger == nil {
		logger = log.Default()
	}
	return &Provider{
		config: config,
		logger: logger,
		events: make(chan RelayEvent, 128),
		done:   make(chan struct{}),
	}
}

// ProviderContext carries the configuration a provider needs to start a session.
// Mirrors internal/runner.ProviderContext to avoid import cycles.
type ProviderContext struct {
	Prompt  string
	Cwd     string
	Model   string
	OnStderr func(string)
	HomeDir string
}

// Start launches the ADK agent and returns a channel of relay events.
func (p *Provider) Start(pctx ProviderContext) (<-chan RelayEvent, error) {
	p.mu.Lock()
	if p.started {
		p.mu.Unlock()
		return nil, fmt.Errorf("provider already started")
	}
	p.started = true
	p.mu.Unlock()

	modelName := pctx.Model
	if modelName == "" {
		modelName = p.config.DefaultModel
	}

	// Resolve API key from environment
	apiKey := resolveEnvVar(p.config.APIKeyEnvVar)
	if apiKey == "" {
		close(p.events)
		close(p.done)
		return nil, fmt.Errorf("%s not set — required for %s provider", p.config.APIKeyEnvVar, p.config.Name)
	}

	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel

	// Create the ADK model
	adkModel, err := p.config.NewModel(ctx, modelName, apiKey)
	if err != nil {
		cancel()
		close(p.events)
		close(p.done)
		return nil, fmt.Errorf("create %s model: %w", p.config.Name, err)
	}

	// Create the adapter
	p.adapter = NewAdapter(
		AdapterModel{Provider: p.config.Provider, ID: adkModel.Name()},
		pctx.Cwd,
	)
	_ = adkModel // adkModel is model.LLM
	p.adapter.AddUserMessage(pctx.Prompt)

	// Build tools
	adkTools, err := AllTools(pctx.Cwd)
	if err != nil {
		cancel()
		close(p.events)
		close(p.done)
		return nil, fmt.Errorf("create tools: %w", err)
	}

	// Create the agent
	instruction := p.config.Instruction
	if instruction == "" {
		instruction = defaultInstruction
	}

	toolList := make([]tool.Tool, len(adkTools))
	copy(toolList, adkTools)

	agentCfg := llmagent.Config{
		Name:        fmt.Sprintf("pizzapi-%s-agent", p.config.Name),
		Model:       adkModel,
		Description: "A PizzaPi coding agent powered by " + p.config.Provider,
		Instruction: instruction,
		Tools:       toolList,
	}

	a, err := llmagent.New(agentCfg)
	if err != nil {
		cancel()
		close(p.events)
		close(p.done)
		return nil, fmt.Errorf("create agent: %w", err)
	}

	// Create session service and session
	p.sessionSvc = session.InMemoryService()
	p.userID = "pizzapi-user"

	sess, err := p.sessionSvc.Create(ctx, &session.CreateRequest{
		AppName: "pizzapi",
		UserID:  p.userID,
	})
	if err != nil {
		cancel()
		close(p.events)
		close(p.done)
		return nil, fmt.Errorf("create session: %w", err)
	}
	p.sessionID = sess.Session.ID()

	// Create the ADK runner
	runnerCfg := runner.Config{
		AppName:        "pizzapi",
		Agent:          a,
		SessionService: p.sessionSvc,
	}
	p.adkRunner, err = runner.New(runnerCfg)
	if err != nil {
		cancel()
		close(p.events)
		close(p.done)
		return nil, fmt.Errorf("create runner: %w", err)
	}

	// Start the agent loop in a goroutine
	go p.runLoop(ctx, pctx.Prompt)

	return p.events, nil
}

// runLoop executes the ADK runner and bridges events to the relay channel.
func (p *Provider) runLoop(ctx context.Context, prompt string) {
	defer close(p.events)
	defer close(p.done)

	userMsg := genai.NewContentFromText(prompt, genai.RoleUser)

	p.logger.Printf("[%s] starting agent with model %s", p.config.Name, p.adapter.model.ID)

	inputTokens, outputTokens := 0, 0
	numTurns := 0

	for event, err := range p.adkRunner.Run(ctx, p.userID, p.sessionID, userMsg, agent.RunConfig{
		StreamingMode: agent.StreamingModeSSE,
	}) {
		if err != nil {
			p.logger.Printf("[%s] runner error: %v", p.config.Name, err)
			p.emit(RelayEvent{
				"type":       "tool_result_message",
				"role":       "tool_result",
				"toolCallId": "",
				"toolName":   "system",
				"content":    fmt.Sprintf("Error: %v", err),
				"isError":    true,
				"timestamp":  time.Now().UnixMilli(),
			})
			continue
		}

		// Track usage from event metadata
		if event.UsageMetadata != nil {
			inputTokens = int(event.UsageMetadata.PromptTokenCount)
			outputTokens = int(event.UsageMetadata.CandidatesTokenCount)
		}
		if event.TurnComplete {
			numTurns++
		}

		// Convert to relay events
		relayEvents := p.adapter.HandleEvent(event)
		for _, re := range relayEvents {
			p.emit(re)
		}
	}

	// Turn complete — emit metadata and idle heartbeat
	endEvents := p.adapter.HandleTurnEnd(inputTokens, outputTokens, 0, numTurns, "end_turn")
	for _, re := range endEvents {
		p.emit(re)
	}

	p.logger.Printf("[%s] agent turn complete (turns=%d, in=%d, out=%d)",
		p.config.Name, numTurns, inputTokens, outputTokens)
}

func (p *Provider) emit(ev RelayEvent) {
	select {
	case p.events <- ev:
	default:
		p.logger.Printf("[%s] event channel full, dropping event type=%v", p.config.Name, ev["type"])
	}
}

// SendMessage sends a follow-up user message to the running agent.
func (p *Provider) SendMessage(text string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if !p.started || p.adkRunner == nil {
		return fmt.Errorf("provider not started")
	}

	p.adapter.AddUserMessage(text)

	// Re-run the agent with the new message
	ctx := context.Background()
	if p.cancel != nil {
		ctx, _ = context.WithCancel(ctx)
	}

	userMsg := genai.NewContentFromText(text, genai.RoleUser)

	go func() {
		inputTokens, outputTokens := 0, 0
		numTurns := 0

		for event, err := range p.adkRunner.Run(ctx, p.userID, p.sessionID, userMsg, agent.RunConfig{
			StreamingMode: agent.StreamingModeSSE,
		}) {
			if err != nil {
				p.logger.Printf("[%s] runner error: %v", p.config.Name, err)
				continue
			}

			if event.UsageMetadata != nil {
				inputTokens = int(event.UsageMetadata.PromptTokenCount)
				outputTokens = int(event.UsageMetadata.CandidatesTokenCount)
			}
			if event.TurnComplete {
				numTurns++
			}

			relayEvents := p.adapter.HandleEvent(event)
			for _, re := range relayEvents {
				p.emit(re)
			}
		}

		endEvents := p.adapter.HandleTurnEnd(inputTokens, outputTokens, 0, numTurns, "end_turn")
		for _, re := range endEvents {
			p.emit(re)
		}
	}()

	return nil
}

// Done returns a channel that closes when the provider exits.
func (p *Provider) Done() <-chan struct{} {
	return p.done
}

// ExitCode returns -1 (ADK providers don't have process exit codes).
func (p *Provider) ExitCode() int {
	return -1
}

// Stop terminates the provider.
func (p *Provider) Stop() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.cancel != nil {
		p.cancel()
	}
	return nil
}

const defaultInstruction = `You are a helpful coding assistant. You have access to tools for reading files, writing files, editing files, and running bash commands. Use these tools to help the user with their coding tasks.

When working with files:
- Use the read tool to examine file contents before making changes
- Use the edit tool for precise, targeted changes (preferred over write for existing files)
- Use the write tool only for new files or complete rewrites
- Use the bash tool for running commands, searching files, and other shell operations

Be concise in your responses. Show file paths clearly when working with files.`

// resolveEnvVar reads an environment variable. Exported as var for test injection.
var resolveEnvVar = os.Getenv
