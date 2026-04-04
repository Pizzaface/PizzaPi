package auth

import (
	"crypto/sha256"
	"testing"
)

func TestGeneratePKCE_VerifierLength(t *testing.T) {
	pkce, err := GeneratePKCE()
	if err != nil {
		t.Fatalf("GeneratePKCE failed: %v", err)
	}
	// 32 bytes base64url = 43 chars (no padding)
	if len(pkce.Verifier) != 43 {
		t.Errorf("expected verifier length 43, got %d", len(pkce.Verifier))
	}
}

func TestGeneratePKCE_ChallengeIsSHA256OfVerifier(t *testing.T) {
	pkce, err := GeneratePKCE()
	if err != nil {
		t.Fatalf("GeneratePKCE failed: %v", err)
	}

	// Manually compute expected challenge
	hash := sha256.Sum256([]byte(pkce.Verifier))
	expected := base64URLEncode(hash[:])

	if pkce.Challenge != expected {
		t.Errorf("challenge mismatch:\ngot:  %s\nwant: %s", pkce.Challenge, expected)
	}
}

func TestGeneratePKCE_UniqueEachCall(t *testing.T) {
	pkce1, _ := GeneratePKCE()
	pkce2, _ := GeneratePKCE()

	if pkce1.Verifier == pkce2.Verifier {
		t.Error("two calls should produce different verifiers")
	}
	if pkce1.Challenge == pkce2.Challenge {
		t.Error("two calls should produce different challenges")
	}
}

func TestGeneratePKCE_NoSpecialChars(t *testing.T) {
	pkce, _ := GeneratePKCE()

	for _, c := range pkce.Verifier {
		if c == '+' || c == '/' || c == '=' {
			t.Errorf("verifier contains non-URL-safe char: %c", c)
		}
	}
	for _, c := range pkce.Challenge {
		if c == '+' || c == '/' || c == '=' {
			t.Errorf("challenge contains non-URL-safe char: %c", c)
		}
	}
}
