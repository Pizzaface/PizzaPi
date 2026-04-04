package auth

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStorage_InMemory_SetGet(t *testing.T) {
	s := InMemoryStorage()

	cred := &Credential{Type: CredTypeAPIKey, Key: "sk-test-123"}
	if err := s.Set("openai", cred); err != nil {
		t.Fatalf("Set failed: %v", err)
	}

	got := s.Get("openai")
	if got == nil {
		t.Fatal("expected credential, got nil")
	}
	if got.Key != "sk-test-123" {
		t.Errorf("expected key 'sk-test-123', got %q", got.Key)
	}
}

func TestStorage_InMemory_OAuthCred(t *testing.T) {
	s := InMemoryStorage()

	cred := &Credential{
		Type:      CredTypeOAuth,
		Access:    "access-token",
		Refresh:   "refresh-token",
		Expires:   time.Now().Add(time.Hour).UnixMilli(),
		AccountID: "acct-123",
	}
	s.Set("openai-codex", cred)

	got := s.Get("openai-codex")
	if got == nil {
		t.Fatal("expected credential")
	}
	if got.Type != CredTypeOAuth {
		t.Errorf("expected oauth type, got %v", got.Type)
	}
	if got.Access != "access-token" {
		t.Errorf("expected access-token, got %q", got.Access)
	}
	if got.AccountID != "acct-123" {
		t.Errorf("expected acct-123, got %q", got.AccountID)
	}
}

func TestStorage_InMemory_Has(t *testing.T) {
	s := InMemoryStorage()
	if s.Has("openai") {
		t.Error("should not have openai initially")
	}
	s.Set("openai", &Credential{Type: CredTypeAPIKey, Key: "k"})
	if !s.Has("openai") {
		t.Error("should have openai after Set")
	}
}

func TestStorage_InMemory_Remove(t *testing.T) {
	s := InMemoryStorage()
	s.Set("openai", &Credential{Type: CredTypeAPIKey, Key: "k"})
	s.Remove("openai")
	if s.Has("openai") {
		t.Error("should not have openai after Remove")
	}
}

func TestStorage_InMemory_List(t *testing.T) {
	s := InMemoryStorage()
	s.Set("openai", &Credential{Type: CredTypeAPIKey, Key: "k1"})
	s.Set("anthropic", &Credential{Type: CredTypeAPIKey, Key: "k2"})

	list := s.List()
	if len(list) != 2 {
		t.Fatalf("expected 2 providers, got %d", len(list))
	}
}

func TestStorage_GetAPIKey_APIKeyCred(t *testing.T) {
	s := InMemoryStorage()
	s.Set("openai", &Credential{Type: CredTypeAPIKey, Key: "sk-test"})

	key, err := s.GetAPIKey("openai", "")
	if err != nil {
		t.Fatalf("GetAPIKey failed: %v", err)
	}
	if key != "sk-test" {
		t.Errorf("expected 'sk-test', got %q", key)
	}
}

func TestStorage_GetAPIKey_OAuthCred(t *testing.T) {
	s := InMemoryStorage()
	s.Set("openai-codex", &Credential{
		Type:    CredTypeOAuth,
		Access:  "access-tok",
		Refresh: "refresh-tok",
		Expires: time.Now().Add(time.Hour).UnixMilli(),
	})

	key, err := s.GetAPIKey("openai-codex", "")
	if err != nil {
		t.Fatalf("GetAPIKey failed: %v", err)
	}
	if key != "access-tok" {
		t.Errorf("expected 'access-tok', got %q", key)
	}
}

func TestStorage_GetAPIKey_ExpiredAutoRefresh(t *testing.T) {
	s := InMemoryStorage()
	s.Set("openai-codex", &Credential{
		Type:    CredTypeOAuth,
		Access:  "old-access",
		Refresh: "refresh-tok",
		Expires: time.Now().Add(-time.Hour).UnixMilli(), // expired
	})

	s.RegisterRefresher("openai-codex", func(refreshToken string) (*Credential, error) {
		if refreshToken != "refresh-tok" {
			t.Errorf("unexpected refresh token: %s", refreshToken)
		}
		return &Credential{
			Type:    CredTypeOAuth,
			Access:  "new-access",
			Refresh: "new-refresh",
			Expires: time.Now().Add(time.Hour).UnixMilli(),
		}, nil
	})

	key, err := s.GetAPIKey("openai-codex", "")
	if err != nil {
		t.Fatalf("GetAPIKey failed: %v", err)
	}
	if key != "new-access" {
		t.Errorf("expected 'new-access', got %q", key)
	}

	// Verify the credential was persisted
	got := s.Get("openai-codex")
	if got.Access != "new-access" {
		t.Errorf("expected persisted new-access, got %q", got.Access)
	}
}

func TestStorage_GetAPIKey_FallbackEnvVar(t *testing.T) {
	s := InMemoryStorage()

	os.Setenv("TEST_OPENAI_KEY", "env-key")
	defer os.Unsetenv("TEST_OPENAI_KEY")

	key, err := s.GetAPIKey("openai", "TEST_OPENAI_KEY")
	if err != nil {
		t.Fatalf("GetAPIKey failed: %v", err)
	}
	if key != "env-key" {
		t.Errorf("expected 'env-key', got %q", key)
	}
}

func TestStorage_GetAPIKey_NoCred(t *testing.T) {
	s := InMemoryStorage()

	key, err := s.GetAPIKey("openai", "")
	if err != nil {
		t.Fatalf("GetAPIKey failed: %v", err)
	}
	if key != "" {
		t.Errorf("expected empty key, got %q", key)
	}
}

func TestStorage_FileRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.json")

	// Write
	s1 := NewStorage(path)
	s1.Set("openai", &Credential{Type: CredTypeAPIKey, Key: "sk-file-test"})
	s1.Set("anthropic", &Credential{
		Type:    CredTypeOAuth,
		Access:  "ant-access",
		Refresh: "ant-refresh",
		Expires: 1234567890000,
	})

	// Read from a new instance
	s2 := NewStorage(path)
	got := s2.Get("openai")
	if got == nil || got.Key != "sk-file-test" {
		t.Errorf("expected sk-file-test, got %v", got)
	}
	got2 := s2.Get("anthropic")
	if got2 == nil || got2.Access != "ant-access" {
		t.Errorf("expected ant-access, got %v", got2)
	}
}

func TestCredential_IsExpired(t *testing.T) {
	future := &Credential{Type: CredTypeOAuth, Expires: time.Now().Add(time.Hour).UnixMilli()}
	if future.IsExpired() {
		t.Error("future credential should not be expired")
	}

	past := &Credential{Type: CredTypeOAuth, Expires: time.Now().Add(-time.Hour).UnixMilli()}
	if !past.IsExpired() {
		t.Error("past credential should be expired")
	}

	apiKey := &Credential{Type: CredTypeAPIKey, Key: "k"}
	if apiKey.IsExpired() {
		t.Error("API key credentials should never be expired")
	}
}
