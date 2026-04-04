package adk

import (
	"testing"
)

func TestProvider_StartFailsWithoutAPIKey(t *testing.T) {
	// Inject empty env var resolver
	origResolve := resolveEnvVar
	resolveEnvVar = func(name string) string { return "" }
	defer func() { resolveEnvVar = origResolve }()

	p := NewProvider(GeminiBackend(), nil)

	_, err := p.Start(ProviderContext{
		Prompt: "Hello",
		Cwd:    "/tmp",
	})
	if err == nil {
		t.Fatal("expected error when API key not set")
	}
	if err.Error() != "GOOGLE_API_KEY not set — required for gemini provider" {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestProvider_StartFailsWhenAlreadyStarted(t *testing.T) {
	p := NewProvider(GeminiBackend(), nil)

	// Manually mark as started to test the guard
	p.started = true

	_, err := p.Start(ProviderContext{Prompt: "Hello", Cwd: "/tmp"})
	if err == nil {
		t.Fatal("expected error on double start")
	}
	if err.Error() != "provider already started" {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestProvider_ExitCode(t *testing.T) {
	p := NewProvider(GeminiBackend(), nil)
	if p.ExitCode() != -1 {
		t.Errorf("expected -1, got %d", p.ExitCode())
	}
}

func TestProvider_StopBeforeStart(t *testing.T) {
	p := NewProvider(GeminiBackend(), nil)
	err := p.Stop()
	if err != nil {
		t.Errorf("Stop before Start should not error, got %v", err)
	}
}

func TestProvider_DoneChannel(t *testing.T) {
	p := NewProvider(GeminiBackend(), nil)
	ch := p.Done()
	if ch == nil {
		t.Error("Done channel should not be nil")
	}
}

func TestProvider_SendMessageBeforeStart(t *testing.T) {
	p := NewProvider(GeminiBackend(), nil)
	err := p.SendMessage("Hello")
	if err == nil {
		t.Fatal("expected error when sending before start")
	}
}
