package adk

import (
	"testing"
)

func TestGeminiBackend_Config(t *testing.T) {
	cfg := GeminiBackend()
	if cfg.Name != "gemini" {
		t.Errorf("expected name 'gemini', got %q", cfg.Name)
	}
	if cfg.Provider != "google" {
		t.Errorf("expected provider 'google', got %q", cfg.Provider)
	}
	if cfg.DefaultModel != "gemini-2.5-flash" {
		t.Errorf("expected default model 'gemini-2.5-flash', got %q", cfg.DefaultModel)
	}
	if cfg.APIKeyEnvVar != "GOOGLE_API_KEY" {
		t.Errorf("expected GOOGLE_API_KEY, got %q", cfg.APIKeyEnvVar)
	}
	if cfg.NewModel == nil {
		t.Error("expected non-nil NewModel function")
	}
}

func TestAllBackends_IncludesGemini(t *testing.T) {
	backends := AllBackends()
	found := false
	for _, b := range backends {
		if b.Name == "gemini" {
			found = true
			break
		}
	}
	if !found {
		t.Error("AllBackends should include gemini")
	}
}
