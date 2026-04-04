package adk

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/auth"

	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/model"
	"google.golang.org/adk/tool"
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

	// AuthProviderID is the credential storage key for OAuth (e.g. "google-gemini-cli").
	// If empty, only env var is used.
	AuthProviderID string

	// Instruction is the system instruction for the agent.
	// If empty, a sensible default is used.
	Instruction string
}



// Provider implements the PizzaPi runner.Provider interface using ADK Go.
// It is configured via BackendConfig for a specific model backend.
type Provider struct {
	config  BackendConfig
	logger  *log.Logger
	runtime *Runtime
	done    chan struct{}

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

	apiKey := ""
	if p.config.AuthProviderID != "" {
		storage := authStorageFactory()
		if storage != nil {
			key, err := storage.GetAPIKey(p.config.AuthProviderID, p.config.APIKeyEnvVar)
			if err == nil && key != "" {
				apiKey = key
			}
		}
	}
	if apiKey == "" {
		apiKey = resolveEnvVar(p.config.APIKeyEnvVar)
	}
	if apiKey == "" {
		return nil, fmt.Errorf("no credentials for %s — set %s or run --login", p.config.Name, p.config.APIKeyEnvVar)
	}

	ctx := context.Background()
	adkModel, err := p.config.NewModel(ctx, modelName, apiKey)
	if err != nil {
		return nil, fmt.Errorf("create %s model: %w", p.config.Name, err)
	}

	adkTools, err := AllTools(pctx.Cwd)
	if err != nil {
		return nil, fmt.Errorf("create tools: %w", err)
	}
	instruction := p.config.Instruction
	if instruction == "" {
		instruction = defaultInstruction
	}
	toolList := make([]tool.Tool, len(adkTools))
	copy(toolList, adkTools)

	a, err := llmagent.New(llmagent.Config{
		Name:        fmt.Sprintf("pizzapi-%s-agent", p.config.Name),
		Model:       adkModel,
		Description: "A PizzaPi coding agent powered by " + p.config.Provider,
		Instruction: instruction,
		Tools:       toolList,
	})
	if err != nil {
		return nil, fmt.Errorf("create agent: %w", err)
	}

	rt, err := NewRuntime(RuntimeConfig{
		AppName:       "pizzapi",
		ProviderName:  p.config.Name,
		ProviderLabel: p.config.Provider,
		ModelID:       adkModel.Name(),
		Cwd:           pctx.Cwd,
		Logger:        p.logger,
		Agent:         a,
	})
	if err != nil {
		return nil, err
	}
	p.runtime = rt
	return p.runtime.Start(pctx.Prompt)
}

// SendMessage sends a follow-up user message to the running agent.
func (p *Provider) SendMessage(text string) error {
	p.mu.Lock()
	rt := p.runtime
	p.mu.Unlock()
	if rt == nil {
		return fmt.Errorf("provider not started")
	}
	return rt.SendMessage(text)
}

// Done returns a channel that closes when the provider exits.
func (p *Provider) Done() <-chan struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.runtime == nil {
		return p.done
	}
	return p.runtime.Done()
}

// ExitCode returns -1 (ADK providers don't have process exit codes).
func (p *Provider) ExitCode() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.runtime == nil {
		return -1
	}
	return p.runtime.ExitCode()
}

// Stop terminates the provider.
func (p *Provider) Stop() error {
	p.mu.Lock()
	rt := p.runtime
	p.mu.Unlock()
	if rt == nil {
		return nil
	}
	return rt.Stop()
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

// authStorageFactory creates an auth storage. Var for test injection.
var authStorageFactory = func() *auth.Storage {
	s := auth.NewStorage("")
	// Register refreshers for all supported OAuth providers
	s.RegisterRefresher("google-gemini-cli", func(refreshToken string) (*auth.Credential, error) {
		return auth.RefreshGeminiToken(refreshToken)
	})
	return s
}
