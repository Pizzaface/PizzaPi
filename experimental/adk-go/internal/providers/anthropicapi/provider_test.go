package anthropicapi

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/auth"
)

func TestAnthropicProviderCallsMessagesAPI(t *testing.T) {
	oldClient := httpClient
	defer func() { httpClient = oldClient }()

	var gotAuth string
	var gotVersion string
	var gotModel string

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		gotAuth = r.Header.Get("x-api-key")
		gotVersion = r.Header.Get("anthropic-version")
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		gotModel, _ = body["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"content":[{"type":"text","text":"hello from anthropic"}],"usage":{"input_tokens":12,"output_tokens":34}}`)
	}))
	defer ts.Close()
	httpClient = ts.Client()

	storage := auth.NewStorage("")
	storage.Set(AnthropicOAuthProvider, &auth.Credential{Type: auth.CredTypeAPIKey, Key: "anth-key"})
	p := NewProvider(Config{
		ProviderName:   AnthropicProviderName,
		AuthProviderID: AnthropicOAuthProvider,
		APIKeyEnvVar:   AnthropicAPIKeyEnvVar,
		DefaultModel:   AnthropicDefaultModel,
		DefaultBaseURL: ts.URL,
		FallbackModels: FallbackAnthropicModels,
	}, storage, log.Default())

	events, err := p.Start(ProviderContext{Prompt: "hi", Cwd: "/tmp"})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	seenFinal := false
	timeout := time.After(2 * time.Second)
	for !seenFinal {
		select {
		case ev := <-events:
			if ev == nil {
				t.Fatal("events channel closed unexpectedly")
			}
			if ev["type"] == "message_end" {
				msg := ev["message"].(map[string]any)
				content := msg["content"].([]map[string]any)
				if content[0]["text"] != "hello from anthropic" {
					t.Fatalf("unexpected final content: %+v", content)
				}
				seenFinal = true
			}
		case <-timeout:
			t.Fatal("timed out waiting for message_end")
		}
	}

	if gotAuth != "anth-key" {
		t.Fatalf("expected x-api-key auth, got %q", gotAuth)
	}
	if gotVersion != "2023-06-01" {
		t.Fatalf("expected anthropic-version header, got %q", gotVersion)
	}
	if gotModel != AnthropicDefaultModel {
		t.Fatalf("expected model %s, got %s", AnthropicDefaultModel, gotModel)
	}
}

func TestCopilotProviderUsesBearerAndDerivedBaseURL(t *testing.T) {
	oldClient := httpClient
	defer func() { httpClient = oldClient }()

	var gotAuth string
	var gotIntegration string
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotIntegration = r.Header.Get("Copilot-Integration-Id")
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"content":[{"type":"text","text":"hello from copilot"}],"usage":{"input_tokens":1,"output_tokens":2}}`)
	}))
	defer ts.Close()
	httpClient = ts.Client()

	baseHost := ts.URL[len("https://"):]
	token := "tid=t;proxy-ep=" + baseHost
	storage := auth.NewStorage("")
	storage.Set(CopilotOAuthProvider, &auth.Credential{Type: auth.CredTypeOAuth, Access: token, Refresh: "gh-token", Expires: time.Now().Add(time.Hour).UnixMilli()})
	p := NewCopilotProvider(storage, log.Default())

	events, err := p.Start(ProviderContext{Prompt: "hi", Cwd: "/tmp"})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	timeout := time.After(2 * time.Second)
	for {
		select {
		case ev := <-events:
			if ev != nil && ev["type"] == "message_end" {
				if gotAuth != "Bearer "+token {
					t.Fatalf("expected bearer auth, got %q", gotAuth)
				}
				if gotIntegration != "vscode-chat" {
					t.Fatalf("expected Copilot-Integration-Id header, got %q", gotIntegration)
				}
				return
			}
		case <-timeout:
			t.Fatal("timed out waiting for copilot response")
		}
	}
}

func TestRegisterOAuthRefresher(t *testing.T) {
	storage := auth.NewStorage("")
	RegisterOAuthRefresher(storage, AnthropicOAuthProvider)
	RegisterOAuthRefresher(storage, CopilotOAuthProvider)
}
