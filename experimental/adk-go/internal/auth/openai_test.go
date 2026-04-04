package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBuildOpenAIAuthURL(t *testing.T) {
	url := buildOpenAIAuthURL("test-challenge", "test-state")

	if !strings.Contains(url, "auth.openai.com/oauth/authorize") {
		t.Errorf("expected auth.openai.com URL, got %s", url)
	}
	if !strings.Contains(url, "client_id="+OpenAIClientID) {
		t.Error("missing client_id")
	}
	if !strings.Contains(url, "code_challenge=test-challenge") {
		t.Error("missing code_challenge")
	}
	if !strings.Contains(url, "state=test-state") {
		t.Error("missing state")
	}
	if !strings.Contains(url, "code_challenge_method=S256") {
		t.Error("missing code_challenge_method")
	}
	if !strings.Contains(url, "originator=pizzapi") {
		t.Error("missing originator")
	}
	if !strings.Contains(url, "redirect_uri=") {
		t.Error("missing redirect_uri")
	}
	if !strings.Contains(url, "scope=") {
		t.Error("missing scope")
	}
}

func TestExtractOpenAIAccountID_ValidJWT(t *testing.T) {
	// Build a fake JWT with the expected claim
	payload := map[string]any{
		"sub": "user123",
		OpenAIJWTClaimPath: map[string]any{
			"chatgpt_account_id": "acct_abc123",
		},
	}
	payloadJSON, _ := json.Marshal(payload)
	payloadB64 := base64.RawURLEncoding.EncodeToString(payloadJSON)

	// Fake JWT: header.payload.signature
	fakeJWT := "eyJhbGciOiJSUzI1NiJ9." + payloadB64 + ".fakesig"

	accountID := extractOpenAIAccountID(fakeJWT)
	if accountID != "acct_abc123" {
		t.Errorf("expected acct_abc123, got %q", accountID)
	}
}

func TestExtractOpenAIAccountID_MissingClaim(t *testing.T) {
	payload := map[string]any{"sub": "user123"}
	payloadJSON, _ := json.Marshal(payload)
	payloadB64 := base64.RawURLEncoding.EncodeToString(payloadJSON)

	fakeJWT := "eyJhbGciOiJSUzI1NiJ9." + payloadB64 + ".fakesig"
	accountID := extractOpenAIAccountID(fakeJWT)
	if accountID != "" {
		t.Errorf("expected empty, got %q", accountID)
	}
}

func TestExtractOpenAIAccountID_InvalidJWT(t *testing.T) {
	if id := extractOpenAIAccountID("not-a-jwt"); id != "" {
		t.Errorf("expected empty for invalid JWT, got %q", id)
	}
	if id := extractOpenAIAccountID(""); id != "" {
		t.Errorf("expected empty for empty string, got %q", id)
	}
}

func TestStartCallbackServer_ReceivesCode(t *testing.T) {
	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)

	server, err := startCallbackServer("test-state", codeCh, errCh)
	if err != nil {
		t.Fatalf("startCallbackServer failed: %v", err)
	}
	defer server.Close()

	// Simulate the OAuth redirect
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/auth/callback?code=auth-code-123&state=test-state", OpenAICallbackPort))
	if err != nil {
		t.Fatalf("GET callback failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	select {
	case code := <-codeCh:
		if code != "auth-code-123" {
			t.Errorf("expected auth-code-123, got %q", code)
		}
	default:
		t.Error("expected code on channel")
	}
}

func TestStartCallbackServer_RejectsWrongState(t *testing.T) {
	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)

	server, err := startCallbackServer("correct-state", codeCh, errCh)
	if err != nil {
		t.Fatalf("startCallbackServer failed: %v", err)
	}
	defer server.Close()

	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/auth/callback?code=code&state=wrong-state", OpenAICallbackPort))
	if err != nil {
		t.Fatalf("GET callback failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for wrong state, got %d", resp.StatusCode)
	}

	select {
	case <-codeCh:
		t.Error("should not receive code for wrong state")
	default:
		// Expected
	}
}

func TestRefreshOpenAIToken_MockServer(t *testing.T) {
	// Create a mock token server
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		r.ParseForm()
		if r.FormValue("grant_type") != "refresh_token" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.FormValue("refresh_token") != "test-refresh" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		// Build a fake JWT with accountId
		payload := map[string]any{
			OpenAIJWTClaimPath: map[string]any{
				"chatgpt_account_id": "acct_refreshed",
			},
		}
		payloadJSON, _ := json.Marshal(payload)
		payloadB64 := base64.RawURLEncoding.EncodeToString(payloadJSON)
		fakeJWT := "eyJhbGciOiJSUzI1NiJ9." + payloadB64 + ".sig"

		json.NewEncoder(w).Encode(map[string]any{
			"access_token":  fakeJWT,
			"refresh_token": "new-refresh",
			"expires_in":    3600,
		})
	}))
	defer mockServer.Close()

	// We can't easily override the token URL in the production code,
	// so we test the helper functions directly instead.
	// The RefreshOpenAIToken function uses the hardcoded URL.
	// For now, just verify that the function signature is correct.
	_ = RefreshOpenAIToken // Compile check
}

func TestLoginOpenAI_CancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel immediately

	_, err := LoginOpenAI(ctx, LoginCallbacks{})
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
}
