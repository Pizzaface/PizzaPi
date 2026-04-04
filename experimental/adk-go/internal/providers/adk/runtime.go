package adk

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/runner"
	"google.golang.org/adk/session"
	"google.golang.org/genai"
)

// RuntimeConfig defines the shared ADK orchestration layer used by PizzaPi
// providers. The long-term goal is for every ADK-founded provider (including
// Claude via an adapter) to plug into this runtime rather than reimplementing
// runner/session/event-loop orchestration per provider.
type RuntimeConfig struct {
	AppName        string
	ProviderName   string
	ProviderLabel  string
	ModelID        string
	Cwd            string
	Logger         *log.Logger
	SessionService session.Service
	Agent          agent.Agent
}

// Runtime owns the common ADK runner/session lifecycle.
type Runtime struct {
	cfg RuntimeConfig

	adapter    *Adapter
	adkRunner  *runner.Runner
	sessionSvc session.Service
	sessionID  string
	userID     string

	events chan RelayEvent
	done   chan struct{}
	cancel context.CancelFunc

	mu      sync.Mutex
	started bool
	closed  bool
}

func NewRuntime(cfg RuntimeConfig) (*Runtime, error) {
	if cfg.Logger == nil {
		cfg.Logger = log.Default()
	}
	if cfg.AppName == "" {
		cfg.AppName = "pizzapi"
	}
	if cfg.SessionService == nil {
		cfg.SessionService = session.InMemoryService()
	}
	if cfg.Agent == nil {
		return nil, fmt.Errorf("runtime agent is required")
	}
	if cfg.ProviderName == "" {
		return nil, fmt.Errorf("runtime provider name is required")
	}

	return &Runtime{
		cfg:        cfg,
		adapter:    NewAdapter(AdapterModel{Provider: cfg.ProviderLabel, ID: cfg.ModelID}, cfg.Cwd),
		sessionSvc: cfg.SessionService,
		userID:     "pizzapi-user",
		events:     make(chan RelayEvent, 128),
		done:       make(chan struct{}),
	}, nil
}

func (r *Runtime) Start(prompt string) (<-chan RelayEvent, error) {
	r.mu.Lock()
	if r.started {
		r.mu.Unlock()
		return nil, fmt.Errorf("provider already started")
	}
	r.started = true
	r.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel

	sess, err := r.sessionSvc.Create(ctx, &session.CreateRequest{
		AppName: r.cfg.AppName,
		UserID:  r.userID,
	})
	if err != nil {
		cancel()
		r.closeChannels()
		return nil, fmt.Errorf("create session: %w", err)
	}
	r.sessionID = sess.Session.ID()

	adkRunner, err := runner.New(runner.Config{
		AppName:        r.cfg.AppName,
		Agent:          r.cfg.Agent,
		SessionService: r.sessionSvc,
	})
	if err != nil {
		cancel()
		r.closeChannels()
		return nil, fmt.Errorf("create runner: %w", err)
	}
	r.adkRunner = adkRunner
	r.adapter.AddUserMessage(prompt)

	go r.runLoop(ctx, prompt)
	return r.events, nil
}

func (r *Runtime) SendMessage(text string) error {
	r.mu.Lock()
	started := r.started && r.adkRunner != nil
	r.mu.Unlock()
	if !started {
		return fmt.Errorf("provider not started")
	}

	r.adapter.AddUserMessage(text)
	go r.runTurn(context.Background(), text)
	return nil
}

func (r *Runtime) Done() <-chan struct{} { return r.done }
func (r *Runtime) ExitCode() int         { return -1 }

func (r *Runtime) Stop() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cancel != nil {
		r.cancel()
	}
	return nil
}

func (r *Runtime) runLoop(ctx context.Context, prompt string) {
	defer r.closeChannels()
	r.runTurn(ctx, prompt)
}

func (r *Runtime) runTurn(ctx context.Context, prompt string) {
	userMsg := genai.NewContentFromText(prompt, genai.RoleUser)
	r.cfg.Logger.Printf("[%s] starting agent with model %s", r.cfg.ProviderName, r.cfg.ModelID)

	inputTokens, outputTokens := 0, 0
	numTurns := 0

	for event, err := range r.adkRunner.Run(ctx, r.userID, r.sessionID, userMsg, agent.RunConfig{
		StreamingMode: agent.StreamingModeSSE,
	}) {
		if err != nil {
			r.cfg.Logger.Printf("[%s] runner error: %v", r.cfg.ProviderName, err)
			r.emit(RelayEvent{
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
		if event.UsageMetadata != nil {
			inputTokens = int(event.UsageMetadata.PromptTokenCount)
			outputTokens = int(event.UsageMetadata.CandidatesTokenCount)
		}
		if event.TurnComplete {
			numTurns++
		}
		for _, re := range r.adapter.HandleEvent(event) {
			r.emit(re)
		}
	}

	for _, re := range r.adapter.HandleTurnEnd(inputTokens, outputTokens, 0, numTurns, "end_turn") {
		r.emit(re)
	}
	r.cfg.Logger.Printf("[%s] agent turn complete (turns=%d, in=%d, out=%d)", r.cfg.ProviderName, numTurns, inputTokens, outputTokens)
}

func (r *Runtime) emit(ev RelayEvent) {
	select {
	case r.events <- ev:
	default:
		r.cfg.Logger.Printf("[%s] event channel full, dropping event type=%v", r.cfg.ProviderName, ev["type"])
	}
}

func (r *Runtime) closeChannels() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	r.closed = true
	close(r.events)
	close(r.done)
}
