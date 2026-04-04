package auth

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// CredentialType distinguishes API key vs OAuth credentials.
type CredentialType string

const (
	CredTypeAPIKey CredentialType = "api_key"
	CredTypeOAuth  CredentialType = "oauth"
)

// Credential represents stored authentication for a provider.
type Credential struct {
	Type CredentialType `json:"type"`

	// API key credentials
	Key string `json:"key,omitempty"`

	// OAuth credentials
	Refresh   string `json:"refresh,omitempty"`
	Access    string `json:"access,omitempty"`
	Expires   int64  `json:"expires,omitempty"` // Unix millis
	AccountID string `json:"accountId,omitempty"`
}

// IsExpired returns true if the OAuth access token has expired.
func (c Credential) IsExpired() bool {
	if c.Type != CredTypeOAuth {
		return false
	}
	// Consider expired 60 seconds before actual expiry for safety margin
	return time.Now().UnixMilli() >= c.Expires-60_000
}

// TokenRefresher can refresh an OAuth token given a refresh token.
type TokenRefresher func(refreshToken string) (*Credential, error)

// Storage manages credential persistence in a JSON file.
// Thread-safe for concurrent access within the same process.
type Storage struct {
	path string
	mu   sync.RWMutex
	data map[string]*Credential

	// Registered refreshers for OAuth providers
	refreshers map[string]TokenRefresher
}

// DefaultPath returns the default auth.json path (~/.pizzapi/auth.json).
func DefaultPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pizzapi", "auth.json")
}

// NewStorage creates a Storage backed by the given file path.
// If path is empty, uses DefaultPath().
func NewStorage(path string) *Storage {
	if path == "" {
		path = DefaultPath()
	}
	s := &Storage{
		path:       path,
		data:       make(map[string]*Credential),
		refreshers: make(map[string]TokenRefresher),
	}
	s.load()
	return s
}

// InMemoryStorage creates a Storage that doesn't persist to disk.
// Useful for testing.
func InMemoryStorage() *Storage {
	return &Storage{
		data:       make(map[string]*Credential),
		refreshers: make(map[string]TokenRefresher),
	}
}

// RegisterRefresher registers a token refresh function for an OAuth provider.
func (s *Storage) RegisterRefresher(provider string, refresher TokenRefresher) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshers[provider] = refresher
}

// Get returns the credential for a provider, or nil if not found.
func (s *Storage) Get(provider string) *Credential {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.data[provider]
}

// Set stores a credential for a provider and persists to disk.
func (s *Storage) Set(provider string, cred *Credential) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data[provider] = cred
	return s.save()
}

// Remove deletes a credential for a provider and persists.
func (s *Storage) Remove(provider string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.data, provider)
	return s.save()
}

// Has returns true if credentials exist for the provider.
func (s *Storage) Has(provider string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.data[provider] != nil
}

// List returns all providers with stored credentials.
func (s *Storage) List() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var providers []string
	for p := range s.data {
		providers = append(providers, p)
	}
	return providers
}

// GetAPIKey resolves the API key for a provider.
// For API key credentials, returns the key directly.
// For OAuth credentials, auto-refreshes if expired.
// Falls back to environment variable if no stored credential.
func (s *Storage) GetAPIKey(provider string, envVar string) (string, error) {
	s.mu.Lock()
	cred := s.data[provider]
	s.mu.Unlock()

	if cred != nil {
		switch cred.Type {
		case CredTypeAPIKey:
			return cred.Key, nil
		case CredTypeOAuth:
			if cred.IsExpired() {
				refreshed, err := s.refreshToken(provider, cred)
				if err != nil {
					return "", fmt.Errorf("refresh %s token: %w", provider, err)
				}
				return refreshed.Access, nil
			}
			return cred.Access, nil
		}
	}

	// Fall back to environment variable
	if envVar != "" {
		if key := os.Getenv(envVar); key != "" {
			return key, nil
		}
	}

	return "", nil
}

// refreshToken refreshes an expired OAuth token and persists the result.
func (s *Storage) refreshToken(provider string, cred *Credential) (*Credential, error) {
	s.mu.RLock()
	refresher, ok := s.refreshers[provider]
	s.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("no refresher registered for %s", provider)
	}

	newCred, err := refresher(cred.Refresh)
	if err != nil {
		return nil, err
	}

	// Persist the refreshed credential
	if err := s.Set(provider, newCred); err != nil {
		return nil, fmt.Errorf("persist refreshed token: %w", err)
	}

	return newCred, nil
}

// load reads credentials from the JSON file.
func (s *Storage) load() {
	if s.path == "" {
		return
	}
	data, err := os.ReadFile(s.path)
	if err != nil {
		return // File doesn't exist yet — that's fine
	}
	var parsed map[string]*Credential
	if err := json.Unmarshal(data, &parsed); err != nil {
		return // Corrupt file — start fresh
	}
	s.data = parsed
}

// save writes credentials to the JSON file with atomic write.
func (s *Storage) save() error {
	if s.path == "" {
		return nil // In-memory only
	}

	// Ensure parent directory exists
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create auth dir: %w", err)
	}

	data, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal auth data: %w", err)
	}

	// Atomic write: write to temp file, then rename
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return fmt.Errorf("write auth temp: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("rename auth file: %w", err)
	}

	return nil
}
