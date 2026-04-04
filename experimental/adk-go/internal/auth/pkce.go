// Package auth provides credential storage and OAuth flows for AI providers.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
)

// PKCE holds a PKCE code verifier and challenge pair.
type PKCE struct {
	Verifier  string
	Challenge string
}

// GeneratePKCE creates a PKCE code verifier (random 32 bytes, base64url) and
// challenge (SHA-256 of verifier, base64url). Used for OAuth 2.0 PKCE flows.
func GeneratePKCE() (PKCE, error) {
	verifierBytes := make([]byte, 32)
	if _, err := rand.Read(verifierBytes); err != nil {
		return PKCE{}, err
	}
	verifier := base64URLEncode(verifierBytes)

	hash := sha256.Sum256([]byte(verifier))
	challenge := base64URLEncode(hash[:])

	return PKCE{Verifier: verifier, Challenge: challenge}, nil
}

// base64URLEncode encodes bytes as base64url without padding.
func base64URLEncode(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}
