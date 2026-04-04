package claudecli

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	guardrails "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/guardrails"
	adkprovider "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/providers/adk"
	"google.golang.org/adk/session"
)

func TestSessionBridgeDeniedToolUseEmitsRelayPassthroughAndWritesToolResult(t *testing.T) {
	var stdinWrites [][]byte
	bridge := NewSessionBridge(SessionBridgeConfig{
		GuardEnv: guardrails.EvalEnv{
			CWD:     t.TempDir(),
			HomeDir: t.TempDir(),
			Session: guardrails.SessionState{PlanMode: true},
		},
		WriteStdin: func(b []byte) error {
			stdinWrites = append(stdinWrites, append([]byte(nil), b...))
			return nil
		},
	})

	raw, _ := json.Marshal(map[string]any{"path": "/tmp/out.txt", "content": "hi"})
	events := bridge.Translate("inv-1", &ToolUseEvent{ToolID: "tool-1", Name: "write", Input: raw})
	if len(events) != 1 {
		t.Fatalf("expected 1 translated event, got %d", len(events))
	}

	relayEvent, ok := events[0].CustomMetadata[relayEventMetadataKey].(RelayEvent)
	if !ok {
		t.Fatalf("expected relay passthrough metadata, got %+v", events[0].CustomMetadata)
	}
	if relayEvent["type"] != "tool_result_message" {
		t.Fatalf("expected tool_result_message, got %+v", relayEvent)
	}
	if relayEvent["isError"] != true {
		t.Fatalf("expected denied tool result to be an error, got %+v", relayEvent)
	}
	if len(stdinWrites) != 1 {
		t.Fatalf("expected 1 stdin write, got %d", len(stdinWrites))
	}
}

func TestRuntimeRelayAdapterReplaysStoredClaudeEvents(t *testing.T) {
	adapter := NewRuntimeRelayAdapter()
	adapter.AddUserMessage("hello from user")

	systemEvent := session.NewEvent("inv-1")
	systemEvent.CustomMetadata = map[string]any{
		claudeEventMetadataKey: &SystemEvent{SessionID: "sess-1", Cwd: "/tmp/project", Model: "claude-sonnet-4-20250514"},
	}

	relayEvents := adapter.HandleEvent(systemEvent)
	if len(relayEvents) != 2 {
		t.Fatalf("expected heartbeat + session_active, got %d", len(relayEvents))
	}
	if relayEvents[0]["type"] != "heartbeat" {
		t.Fatalf("expected heartbeat, got %+v", relayEvents[0])
	}
	if relayEvents[1]["type"] != "session_active" {
		t.Fatalf("expected session_active, got %+v", relayEvents[1])
	}

	assistantEvent := session.NewEvent("inv-1")
	assistantEvent.CustomMetadata = map[string]any{
		claudeEventMetadataKey: &AssistantMessage{Message: mustRawJSON(t, map[string]any{
			"id":   "msg_01",
			"role": "assistant",
			"content": []map[string]any{
				{"type": "text", "text": "hello from claude"},
			},
		})},
	}

	relayEvents = adapter.HandleEvent(assistantEvent)
	if len(relayEvents) != 2 {
		t.Fatalf("expected final assistant message_update + message_end, got %d", len(relayEvents))
	}
	if relayEvents[0]["type"] != "message_update" || relayEvents[1]["type"] != "message_end" {
		t.Fatalf("unexpected relay sequence: %+v", relayEvents)
	}
}

func TestClaudeSessionAgentResumesPreviousClaudeSession(t *testing.T) {
	var (
		mu      sync.Mutex
		configs []RunnerConfig
		script  = [][]ClaudeEvent{
			{
				&SystemEvent{SessionID: "sess-1", Cwd: "/tmp/project", Model: "claude-sonnet-4-20250514"},
				&ResultEvent{SessionID: "sess-1", InputTokens: 10, OutputTokens: 20},
			},
			{
				&SystemEvent{SessionID: "sess-1", Cwd: "/tmp/project", Model: "claude-sonnet-4-20250514"},
				&ResultEvent{SessionID: "sess-1", InputTokens: 11, OutputTokens: 21},
			},
		}
	)

	agentImpl, err := NewClaudeSessionAgent(ClaudeSessionAgentConfig{
		RunnerConfig: RunnerConfig{Model: "claude-sonnet-4-20250514"},
		NewRunner: func(cfg RunnerConfig) runnerClient {
			mu.Lock()
			defer mu.Unlock()
			configs = append(configs, cfg)
			idx := len(configs) - 1
			return &stubRunner{events: script[idx]}
		},
	})
	if err != nil {
		t.Fatalf("create ClaudeSessionAgent: %v", err)
	}

	rt, err := adkprovider.NewRuntime(adkprovider.RuntimeConfig{
		ProviderName:       "claude-cli",
		ProviderLabel:      "anthropic",
		ModelID:            "claude-sonnet-4-20250514",
		Agent:              agentImpl,
		RelayAdapter:       NewRuntimeRelayAdapter(),
		DisableTurnSummary: true,
	})
	if err != nil {
		t.Fatalf("NewRuntime: %v", err)
	}

	if _, err := rt.Start("first"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	waitForConfigs(t, &mu, &configs, 1)

	if err := rt.SendMessage("second"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	waitForConfigs(t, &mu, &configs, 2)

	mu.Lock()
	defer mu.Unlock()
	if configs[0].ResumeSessionID != "" {
		t.Fatalf("expected first turn to start new Claude session, got resume=%q", configs[0].ResumeSessionID)
	}
	if configs[1].ResumeSessionID != "sess-1" {
		t.Fatalf("expected second turn to resume sess-1, got %q", configs[1].ResumeSessionID)
	}

	if err := rt.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
}

func mustRawJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal json: %v", err)
	}
	return b
}

type stubRunner struct {
	events []ClaudeEvent
}

func (r *stubRunner) StartInteractive(ctx context.Context, prompt string) (<-chan ClaudeEvent, error) {
	out := make(chan ClaudeEvent, len(r.events))
	for _, ev := range r.events {
		out <- ev
	}
	close(out)
	return out, nil
}

func (r *stubRunner) WriteStdin(msg []byte) error { return nil }
func (r *stubRunner) Stop() error                 { return nil }

func waitForConfigs(t *testing.T, mu *sync.Mutex, configs *[]RunnerConfig, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		got := len(*configs)
		mu.Unlock()
		if got >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	got := len(*configs)
	mu.Unlock()
	t.Fatalf("timed out waiting for %d runner configs, got %d", want, got)
}
