package claudecli

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"log"
	"sync"
	"time"

	guardrails "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/guardrails"
	"google.golang.org/adk/agent"
	"google.golang.org/adk/session"
	"google.golang.org/genai"
)

const (
	claudeEventMetadataKey = "pizzapi_claude_event"
	relayEventMetadataKey  = "pizzapi_relay_event"
)

type SessionBridgeConfig struct {
	GuardEnv   guardrails.EvalEnv
	WriteStdin func([]byte) error
	Logger     *log.Logger
}

type SessionBridge struct {
	guardEnv   guardrails.EvalEnv
	writeStdin func([]byte) error
	logger     *log.Logger
}

func NewSessionBridge(cfg SessionBridgeConfig) *SessionBridge {
	if cfg.Logger == nil {
		cfg.Logger = log.Default()
	}
	return &SessionBridge{
		guardEnv:   cfg.GuardEnv,
		writeStdin: cfg.WriteStdin,
		logger:     cfg.Logger,
	}
}

func (b *SessionBridge) Translate(invocationID string, ev ClaudeEvent) []*session.Event {
	if toolUse, ok := ev.(*ToolUseEvent); ok {
		if deniedEvent, handled := b.handleDeniedToolUse(invocationID, toolUse); handled {
			return []*session.Event{deniedEvent}
		}
	}

	translated := session.NewEvent(invocationID)
	translated.Author = "claude-cli"
	translated.CustomMetadata = map[string]any{claudeEventMetadataKey: ev}

	switch e := ev.(type) {
	case *ToolUseEvent:
		translated.Content = genai.NewContentFromFunctionCall(e.Name, decodeInput(e.Input), genai.RoleModel)
		if len(translated.Content.Parts) > 0 && translated.Content.Parts[0].FunctionCall != nil {
			translated.Content.Parts[0].FunctionCall.ID = e.ToolID
		}
	case *ToolResultEvent:
		translated.Content = genai.NewContentFromFunctionResponse("tool", map[string]any{"output": e.Content}, genai.RoleUser)
		if len(translated.Content.Parts) > 0 && translated.Content.Parts[0].FunctionResponse != nil {
			translated.Content.Parts[0].FunctionResponse.ID = e.ToolID
		}
	case *UserMessage:
		if e.ToolUseID != "" {
			translated.Content = genai.NewContentFromFunctionResponse("tool", map[string]any{"output": e.Content}, genai.RoleUser)
			if len(translated.Content.Parts) > 0 && translated.Content.Parts[0].FunctionResponse != nil {
				translated.Content.Parts[0].FunctionResponse.ID = e.ToolUseID
			}
		}
	case *ResultEvent:
		translated.TurnComplete = true
		translated.UsageMetadata = &genai.GenerateContentResponseUsageMetadata{
			PromptTokenCount:     int32(e.InputTokens),
			CandidatesTokenCount: int32(e.OutputTokens),
		}
	}

	return []*session.Event{translated}
}

func (b *SessionBridge) handleDeniedToolUse(invocationID string, e *ToolUseEvent) (*session.Event, bool) {
	call := guardrails.ToolCall{Name: e.Name, Args: decodeInput(e.Input)}
	decision := guardrails.EvaluateToolCall(call, b.guardEnv)
	if decision.Allowed {
		return nil, false
	}

	b.logger.Printf("[guardrails] denied tool %q (id=%s): %s", e.Name, e.ToolID, decision.Reason)

	toolResultMsg := map[string]any{
		"type":        "tool_result",
		"tool_use_id": e.ToolID,
		"content":     "Error: " + decision.Reason,
		"is_error":    true,
	}
	if msgBytes, err := json.Marshal(toolResultMsg); err == nil {
		msgBytes = append(msgBytes, '\n')
		if b.writeStdin != nil {
			if err := b.writeStdin(msgBytes); err != nil {
				b.logger.Printf("[guardrails] failed to write tool_result to stdin: %v", err)
			}
		}
	}

	translated := session.NewEvent(invocationID)
	translated.Author = "claude-cli"
	translated.CustomMetadata = map[string]any{
		relayEventMetadataKey: RelayEvent{
			"type":       "tool_result_message",
			"role":       "tool_result",
			"toolCallId": e.ToolID,
			"toolName":   e.Name,
			"content":    "Error: " + decision.Reason,
			"isError":    true,
			"timestamp":  time.Now().UnixMilli(),
		},
	}
	return translated, true
}

type RuntimeRelayAdapter struct {
	mu      sync.Mutex
	adapter *Adapter
}

func NewRuntimeRelayAdapter() *RuntimeRelayAdapter {
	return &RuntimeRelayAdapter{adapter: NewAdapter()}
}

func (a *RuntimeRelayAdapter) AddUserMessage(text string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.adapter.SetUserPrompt(text)
}

func (a *RuntimeRelayAdapter) HandleEvent(ev *session.Event) []map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	if ev == nil || ev.CustomMetadata == nil {
		return nil
	}
	if relayEvent, ok := ev.CustomMetadata[relayEventMetadataKey].(RelayEvent); ok {
		return []map[string]any{relayEvent}
	}
	claudeEvent, ok := ev.CustomMetadata[claudeEventMetadataKey].(ClaudeEvent)
	if !ok {
		return nil
	}
	relayEvents := a.adapter.HandleEvent(claudeEvent)
	out := make([]map[string]any, 0, len(relayEvents))
	for _, relayEvent := range relayEvents {
		out = append(out, relayEvent)
	}
	return out
}

func (a *RuntimeRelayAdapter) HandleTurnEnd(inputTokens, outputTokens int, costUSD float64, numTurns int, stopReason string) []map[string]any {
	return nil
}

type runnerClient interface {
	StartInteractive(ctx context.Context, prompt string) (<-chan ClaudeEvent, error)
	WriteStdin(msg []byte) error
	Stop() error
}

type runnerFactory func(cfg RunnerConfig) runnerClient

type ClaudeSessionAgentConfig struct {
	Name         string
	Description  string
	RunnerConfig RunnerConfig
	GuardEnv     guardrails.EvalEnv
	Logger       *log.Logger
	NewRunner    runnerFactory
}

type ClaudeSessionAgent struct {
	cfg    ClaudeSessionAgentConfig
	logger *log.Logger

	mu              sync.Mutex
	resumeSessionID string
}

func NewClaudeSessionAgent(cfg ClaudeSessionAgentConfig) (agent.Agent, error) {
	if cfg.Name == "" {
		cfg.Name = "claude-cli"
	}
	if cfg.Description == "" {
		cfg.Description = "Claude Code CLI session agent"
	}
	if cfg.Logger == nil {
		cfg.Logger = log.Default()
	}
	if cfg.NewRunner == nil {
		cfg.NewRunner = func(rc RunnerConfig) runnerClient { return NewRunner(rc) }
	}

	sessionAgent := &ClaudeSessionAgent{cfg: cfg, logger: cfg.Logger}
	return agent.New(agent.Config{
		Name:        cfg.Name,
		Description: cfg.Description,
		Run:         sessionAgent.run,
	})
}

func (a *ClaudeSessionAgent) run(ctx agent.InvocationContext) iter.Seq2[*session.Event, error] {
	return func(yield func(*session.Event, error) bool) {
		prompt := textFromContent(ctx.UserContent())
		runnerCfg := a.cfg.RunnerConfig
		runnerCfg.ResumeSessionID = a.currentResumeSessionID()

		runner := a.cfg.NewRunner(runnerCfg)
		bridge := NewSessionBridge(SessionBridgeConfig{
			GuardEnv:   a.cfg.GuardEnv,
			WriteStdin: runner.WriteStdin,
			Logger:     a.logger,
		})

		rawEvents, err := runner.StartInteractive(ctx, prompt)
		if err != nil {
			yield(nil, err)
			return
		}
		defer func() {
			if err := runner.Stop(); err != nil {
				a.logger.Printf("[claude-cli] stop runner: %v", err)
			}
		}()

		for ev := range rawEvents {
			switch e := ev.(type) {
			case *SystemEvent:
				if e.SessionID != "" {
					a.setResumeSessionID(e.SessionID)
				}
			case *ResultEvent:
				if e.SessionID != "" {
					a.setResumeSessionID(e.SessionID)
				}
			}

			for _, translated := range bridge.Translate(ctx.InvocationID(), ev) {
				if !yield(translated, nil) {
					return
				}
			}

			if _, ok := ev.(*ResultEvent); ok {
				return
			}
		}
	}
}

func (a *ClaudeSessionAgent) currentResumeSessionID() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.resumeSessionID
}

func (a *ClaudeSessionAgent) setResumeSessionID(sessionID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.resumeSessionID = sessionID
}

func decodeInput(raw json.RawMessage) map[string]any {
	if len(raw) == 0 {
		return map[string]any{}
	}
	var args map[string]any
	if err := json.Unmarshal(raw, &args); err != nil {
		return map[string]any{"_raw": string(raw), "_parseError": err.Error()}
	}
	return args
}

func textFromContent(content *genai.Content) string {
	if content == nil {
		return ""
	}
	if len(content.Parts) == 0 {
		return ""
	}
	result := ""
	for _, part := range content.Parts {
		if part == nil || part.Text == "" {
			continue
		}
		if result != "" {
			result += "\n"
		}
		result += part.Text
	}
	return result
}

func relayEventFromSessionEvent(ev *session.Event) (RelayEvent, bool) {
	if ev == nil || ev.CustomMetadata == nil {
		return nil, false
	}
	re, ok := ev.CustomMetadata[relayEventMetadataKey].(RelayEvent)
	return re, ok
}

func claudeEventFromSessionEvent(ev *session.Event) (ClaudeEvent, bool) {
	if ev == nil || ev.CustomMetadata == nil {
		return nil, false
	}
	ce, ok := ev.CustomMetadata[claudeEventMetadataKey].(ClaudeEvent)
	return ce, ok
}

func eventDebugString(ev ClaudeEvent) string {
	if ev == nil {
		return "<nil>"
	}
	return fmt.Sprintf("%T", ev)
}
