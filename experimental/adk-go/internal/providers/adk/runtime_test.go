package adk

import (
	"iter"
	"testing"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/session"
)

func TestNewRuntimeRequiresAgent(t *testing.T) {
	_, err := NewRuntime(RuntimeConfig{ProviderName: "gemini", ProviderLabel: "google"})
	if err == nil {
		t.Fatal("expected error when agent is nil")
	}
}

func TestNewRuntimeDefaults(t *testing.T) {
	a, err := agent.New(agent.Config{
		Name:        "test-agent",
		Description: "test",
		Run: func(ctx agent.InvocationContext) iter.Seq2[*session.Event, error] {
			return func(yield func(*session.Event, error) bool) {}
		},
	})
	if err != nil {
		t.Fatalf("create test agent: %v", err)
	}

	rt, err := NewRuntime(RuntimeConfig{
		ProviderName:  "gemini",
		ProviderLabel: "google",
		ModelID:       "gemini-2.5-flash",
		Agent:         a,
	})
	if err != nil {
		t.Fatalf("NewRuntime failed: %v", err)
	}
	if rt.cfg.AppName != "pizzapi" {
		t.Fatalf("expected default app name pizzapi, got %q", rt.cfg.AppName)
	}
	if rt.sessionSvc == nil {
		t.Fatal("expected default session service")
	}
}
