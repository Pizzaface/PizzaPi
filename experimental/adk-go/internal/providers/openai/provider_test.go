package openai

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/auth"
)

func TestProvider_NeedsLogin_NoCredentials(t *testing.T) {
	storage := auth.InMemoryStorage()
	p := NewProvider(storage, nil)
	if !p.NeedsLogin() {
		t.Error("expected NeedsLogin=true with no credentials")
	}
}

func TestProvider_NeedsLogin_WithOAuthCred(t *testing.T) {
	storage := auth.InMemoryStorage()
	storage.Set(OAuthProviderID, &auth.Credential{
		Type:   auth.CredTypeOAuth,
		Access: "tok",
	})
	p := NewProvider(storage, nil)
	if p.NeedsLogin() {
		t.Error("expected NeedsLogin=false with OAuth credential")
	}
}

func TestProvider_NeedsLogin_WithEnvVar(t *testing.T) {
	storage := auth.InMemoryStorage()
	t.Setenv("OPENAI_API_KEY", "sk-test")
	p := NewProvider(storage, nil)
	if p.NeedsLogin() {
		t.Error("expected NeedsLogin=false with OPENAI_API_KEY set")
	}
}

func TestProvider_StartFailsWithNoCreds(t *testing.T) {
	storage := auth.InMemoryStorage()
	p := NewProvider(storage, nil)
	_, err := p.Start(ProviderContext{Prompt: "hi", Cwd: "/tmp"})
	if err == nil {
		t.Fatal("expected error with no credentials")
	}
}

func TestProvider_StartFailsDoubleStart(t *testing.T) {
	storage := auth.InMemoryStorage()
	p := NewProvider(storage, nil)
	p.started = true

	_, err := p.Start(ProviderContext{Prompt: "hi", Cwd: "/tmp"})
	if err == nil {
		t.Fatal("expected error on double start")
	}
}

func TestProvider_SendMessageBeforeStart(t *testing.T) {
	storage := auth.InMemoryStorage()
	p := NewProvider(storage, nil)
	err := p.SendMessage("hello")
	if err == nil {
		t.Fatal("expected error before start")
	}
}

func TestProvider_ExitCode(t *testing.T) {
	p := NewProvider(nil, nil)
	if p.ExitCode() != -1 {
		t.Errorf("expected -1, got %d", p.ExitCode())
	}
}

func TestProvider_StopBeforeStart(t *testing.T) {
	p := NewProvider(nil, nil)
	if err := p.Stop(); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestProvider_CallsAPIWithCredentials(t *testing.T) {
	// Mock OpenAI Responses API server
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-access-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}

		// Verify it hits the Responses API endpoint
		if r.URL.Path != "/responses" {
			t.Errorf("expected /responses endpoint, got %s", r.URL.Path)
		}

		var req responsesRequest
		json.NewDecoder(r.Body).Decode(&req)

		if req.Model != "gpt-4o" {
			t.Errorf("expected model gpt-4o, got %s", req.Model)
		}

		json.NewEncoder(w).Encode(responsesResponse{
			ID: "resp_123",
			Output: []struct {
				Type    string `json:"type"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			}{
				{
					Type: "message",
					Content: []struct {
						Type string `json:"type"`
						Text string `json:"text"`
					}{
						{Type: "output_text", Text: "Hello from mock!"},
					},
				},
			},
			Usage: struct {
				InputTokens  int `json:"input_tokens"`
				OutputTokens int `json:"output_tokens"`
			}{InputTokens: 10, OutputTokens: 5},
			Status: "completed",
		})
	}))
	defer mockServer.Close()

	storage := auth.InMemoryStorage()
	storage.Set(OAuthProviderID, &auth.Credential{
		Type:    auth.CredTypeOAuth,
		Access:  "test-access-token",
		Refresh: "test-refresh",
		Expires: nowMillis() + 3600_000, // 1 hour from now
	})

	p := NewProvider(storage, nil)
	p.baseURL = mockServer.URL // Override to mock server

	events, err := p.Start(ProviderContext{Prompt: "hello", Cwd: "/tmp"})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	// Collect events until idle heartbeat
	var collected []RelayEvent
	for ev := range events {
		collected = append(collected, ev)
		if ev["type"] == "heartbeat" {
			if active, ok := ev["active"].(bool); ok && !active {
				break
			}
		}
	}

	// Verify we got expected event types
	types := make(map[string]bool)
	for _, ev := range collected {
		if t, ok := ev["type"].(string); ok {
			types[t] = true
		}
	}

	required := []string{"heartbeat", "session_active", "message_start", "message_update", "message_end", "session_metadata_update"}
	for _, r := range required {
		if !types[r] {
			t.Errorf("missing event type %q", r)
		}
	}
}

func TestRegisterOAuthRefresher(t *testing.T) {
	storage := auth.InMemoryStorage()
	RegisterOAuthRefresher(storage)
	// Just verify it doesn't panic — actual refresh tested in auth package
}
