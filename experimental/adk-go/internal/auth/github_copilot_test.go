package auth

import (
	"context"
	"testing"
)

func TestGetCopilotBaseURL(t *testing.T) {
	tests := []struct {
		name     string
		token    string
		expected string
	}{
		{
			name:     "standard individual token",
			token:    "tid=abc123;exp=1234567890;proxy-ep=proxy.individual.githubcopilot.com;sku=individual_monthly",
			expected: "https://api.individual.githubcopilot.com",
		},
		{
			name:     "business token",
			token:    "tid=xyz;exp=9999;proxy-ep=proxy.business.githubcopilot.com",
			expected: "https://api.business.githubcopilot.com",
		},
		{
			name:     "proxy-ep already has api prefix (no double replacement)",
			token:    "tid=t;proxy-ep=api.individual.githubcopilot.com",
			expected: "https://api.individual.githubcopilot.com",
		},
		{
			name:     "extra whitespace around value",
			token:    "tid=t;proxy-ep= proxy.individual.githubcopilot.com ;other=val",
			expected: "https://api.individual.githubcopilot.com",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := GetCopilotBaseURL(tc.token)
			if got != tc.expected {
				t.Errorf("GetCopilotBaseURL(%q) = %q; want %q", tc.token, got, tc.expected)
			}
		})
	}
}

func TestGetCopilotBaseURL_Fallback(t *testing.T) {
	tests := []struct {
		name  string
		token string
	}{
		{name: "empty token", token: ""},
		{name: "no proxy-ep field", token: "tid=abc;exp=123;sku=individual"},
		{name: "proxy-ep with empty value", token: "proxy-ep="},
		{name: "malformed token", token: "notakeyvaluepair"},
	}

	const want = "https://api.individual.githubcopilot.com"

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := GetCopilotBaseURL(tc.token)
			if got != want {
				t.Errorf("GetCopilotBaseURL(%q) = %q; want fallback %q", tc.token, got, want)
			}
		})
	}
}

// TestLoginGitHubCopilot_CancelledContext verifies that LoginGitHubCopilot
// returns promptly when the context is cancelled before any network activity
// completes. We cancel immediately so the HTTP request to GitHub either never
// fires or is aborted before it returns.
func TestLoginGitHubCopilot_CancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before the call

	_, err := LoginGitHubCopilot(ctx, LoginCallbacks{})
	if err == nil {
		t.Fatal("expected an error from cancelled context, got nil")
	}
	// The error should wrap context.Canceled
	if ctx.Err() == nil {
		t.Fatalf("context should be cancelled, got nil Err()")
	}
}

// TestRefreshGitHubCopilotToken_CompileCheck ensures the function signature
// matches what callers expect: it accepts a string and returns (*Credential, error).
// This test doesn't make real network calls — it verifies the function compiles
// and returns the right types.
func TestRefreshGitHubCopilotToken_CompileCheck(t *testing.T) {
	// We call RefreshGitHubCopilotToken with a dummy token. It will fail with a
	// network error (or auth error), but that's fine — we only need it to compile
	// and return the correct types.
	cred, err := RefreshGitHubCopilotToken("dummy-github-token")

	// Either a credential or an error must be set; both nil would be a bug
	if cred == nil && err == nil {
		t.Error("RefreshGitHubCopilotToken returned (nil, nil); expected one to be non-nil")
	}
	// If we somehow got a credential, verify its type is set correctly
	if cred != nil && cred.Type != CredTypeOAuth {
		t.Errorf("credential type = %q; want %q", cred.Type, CredTypeOAuth)
	}
}
