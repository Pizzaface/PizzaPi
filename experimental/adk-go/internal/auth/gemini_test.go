package auth

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBuildGeminiAuthURL(t *testing.T) {
	authURL := buildGeminiAuthURL("test-challenge", "test-state")

	checks := []struct {
		name    string
		contain string
	}{
		{"base URL", "accounts.google.com/o/oauth2/v2/auth"},
		{"response_type", "response_type=code"},
		{"client_id", "client_id=" + GeminiClientID},
		{"redirect_uri", "redirect_uri="},
		{"scope", "scope="},
		{"code_challenge", "code_challenge=test-challenge"},
		{"code_challenge_method", "code_challenge_method=S256"},
		{"state", "state=test-state"},
		{"access_type", "access_type=offline"},
		{"prompt", "prompt=consent"},
	}

	for _, c := range checks {
		if !strings.Contains(authURL, c.contain) {
			t.Errorf("[%s] expected URL to contain %q, got: %s", c.name, c.contain, authURL)
		}
	}

	// Ensure cloud-platform scope is present (may be URL-encoded)
	if !strings.Contains(authURL, "cloud-platform") && !strings.Contains(authURL, "cloud%2Dplatform") {
		t.Errorf("expected cloud-platform scope in URL, got: %s", authURL)
	}
}

func TestRefreshGeminiToken_CompileCheck(t *testing.T) {
	// Verify that RefreshGeminiToken compiles with the expected signature.
	// No real network call is made.
	_ = RefreshGeminiToken
}

func TestLoginGemini_CancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel immediately — flow must abort before any real I/O

	_, err := LoginGemini(ctx, LoginCallbacks{})
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
}

// --- callback handler tests (use httptest to avoid requiring port 8085 free) ---

// geminiCallbackMux builds a handler mux that replicates the logic in
// startGeminiCallbackServer so we can test the routing without a real TCP bind.
func geminiCallbackMux(expectedState string, codeCh chan<- string, errCh chan<- error) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth2callback", func(w http.ResponseWriter, r *http.Request) {
		state := r.URL.Query().Get("state")
		if state != expectedState {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, htmlError("State mismatch. Please try logging in again."))
			return
		}
		if oauthErr := r.URL.Query().Get("error"); oauthErr != "" {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, htmlError("Google login failed: "+oauthErr))
			select {
			case errCh <- fmt.Errorf("google oauth error: %s", oauthErr):
			default:
			}
			return
		}
		code := r.URL.Query().Get("code")
		if code == "" {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, htmlError("Missing authorization code."))
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, htmlSuccess("Google authentication successful! You can close this window."))
		select {
		case codeCh <- code:
		default:
		}
	})
	return mux
}

func TestGeminiCallbackHandler_ReceivesCode(t *testing.T) {
	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)

	ts := httptest.NewServer(geminiCallbackMux("test-state", codeCh, errCh))
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/oauth2callback?code=gemini-code-123&state=test-state")
	if err != nil {
		t.Fatalf("GET callback failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	select {
	case code := <-codeCh:
		if code != "gemini-code-123" {
			t.Errorf("expected gemini-code-123, got %q", code)
		}
	default:
		t.Error("expected code on channel")
	}
}

func TestGeminiCallbackHandler_RejectsWrongState(t *testing.T) {
	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)

	ts := httptest.NewServer(geminiCallbackMux("correct-state", codeCh, errCh))
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/oauth2callback?code=code&state=wrong-state")
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

func TestGeminiCallbackHandler_HandlesOAuthError(t *testing.T) {
	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)

	ts := httptest.NewServer(geminiCallbackMux("test-state", codeCh, errCh))
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/oauth2callback?error=access_denied&state=test-state")
	if err != nil {
		t.Fatalf("GET callback failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for oauth error, got %d", resp.StatusCode)
	}

	select {
	case cbErr := <-errCh:
		if !strings.Contains(cbErr.Error(), "access_denied") {
			t.Errorf("expected access_denied in error, got: %v", cbErr)
		}
	default:
		t.Error("expected error on errCh for oauth error param")
	}
}
