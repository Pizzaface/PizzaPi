package auth

import (
	"context"
	"crypto/rand"
	b64 "encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// OpenAI Codex OAuth constants — same as pi / Codex CLI.
const (
	OpenAIClientID    = "app_EMoamEEZ73f0CkXaXp7hrann"
	OpenAIAuthorizeURL = "https://auth.openai.com/oauth/authorize"
	OpenAITokenURL     = "https://auth.openai.com/oauth/token"
	OpenAIRedirectURI  = "http://localhost:1455/auth/callback"
	OpenAIScopes       = "openid profile email offline_access"
	OpenAIJWTClaimPath = "https://api.openai.com/auth"
	OpenAICallbackPort = 1455
)

// LoginCallbacks provides UI hooks for the OAuth flow.
type LoginCallbacks struct {
	// OnAuth is called with the URL to open in the browser.
	OnAuth func(url string, instructions string)
	// OnProgress is called with status updates.
	OnProgress func(message string)
	// OnError is called if the flow fails.
	OnError func(err error)
}

// LoginOpenAI runs the full OpenAI Codex OAuth login flow:
// 1. Generate PKCE verifier/challenge
// 2. Build authorization URL
// 3. Start local callback server on :1455
// 4. Wait for user to complete browser login
// 5. Exchange authorization code for tokens
// 6. Extract accountId from JWT
func LoginOpenAI(ctx context.Context, callbacks LoginCallbacks) (*Credential, error) {
	// 1. Generate PKCE
	pkce, err := GeneratePKCE()
	if err != nil {
		return nil, fmt.Errorf("generate PKCE: %w", err)
	}

	// 2. Generate state
	stateBytes := make([]byte, 16)
	if _, err := rand.Read(stateBytes); err != nil {
		return nil, fmt.Errorf("generate state: %w", err)
	}
	state := hex.EncodeToString(stateBytes)

	// 3. Build authorization URL
	authURL := buildOpenAIAuthURL(pkce.Challenge, state)

	// 4. Start local callback server
	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)
	server, err := startCallbackServer(state, codeCh, errCh)
	if err != nil {
		return nil, fmt.Errorf("start callback server: %w", err)
	}
	defer server.Close()

	// 5. Notify UI to open browser
	if callbacks.OnAuth != nil {
		callbacks.OnAuth(authURL, "A browser window should open. Complete login to finish.")
	}
	if callbacks.OnProgress != nil {
		callbacks.OnProgress("Waiting for authentication...")
	}

	// 6. Wait for code or context cancellation
	var code string
	select {
	case code = <-codeCh:
		// Got the code from callback
	case err := <-errCh:
		return nil, fmt.Errorf("callback server: %w", err)
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	if callbacks.OnProgress != nil {
		callbacks.OnProgress("Exchanging authorization code...")
	}

	// 7. Exchange code for tokens
	tokens, err := exchangeOpenAICode(code, pkce.Verifier)
	if err != nil {
		return nil, fmt.Errorf("exchange code: %w", err)
	}

	// 8. Extract accountId from JWT
	accountID := extractOpenAIAccountID(tokens.Access)
	if accountID == "" {
		return nil, fmt.Errorf("failed to extract accountId from access token")
	}
	tokens.AccountID = accountID

	if callbacks.OnProgress != nil {
		callbacks.OnProgress("Login successful!")
	}

	return tokens, nil
}

// RefreshOpenAIToken refreshes an expired OpenAI OAuth access token.
func RefreshOpenAIToken(refreshToken string) (*Credential, error) {
	data := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {OpenAIClientID},
	}

	resp, err := http.PostForm(OpenAITokenURL, data)
	if err != nil {
		return nil, fmt.Errorf("refresh request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("refresh failed (status %d): %s", resp.StatusCode, string(body))
	}

	var tokenResp tokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return nil, fmt.Errorf("decode refresh response: %w", err)
	}

	if tokenResp.AccessToken == "" || tokenResp.RefreshToken == "" {
		return nil, fmt.Errorf("refresh response missing required fields")
	}

	accountID := extractOpenAIAccountID(tokenResp.AccessToken)

	return &Credential{
		Type:      CredTypeOAuth,
		Access:    tokenResp.AccessToken,
		Refresh:   tokenResp.RefreshToken,
		Expires:   time.Now().UnixMilli() + int64(tokenResp.ExpiresIn)*1000,
		AccountID: accountID,
	}, nil
}

// --- internal helpers ---

func buildOpenAIAuthURL(challenge, state string) string {
	u, _ := url.Parse(OpenAIAuthorizeURL)
	q := u.Query()
	q.Set("response_type", "code")
	q.Set("client_id", OpenAIClientID)
	q.Set("redirect_uri", OpenAIRedirectURI)
	q.Set("scope", OpenAIScopes)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("state", state)
	q.Set("id_token_add_organizations", "true")
	q.Set("codex_cli_simplified_flow", "true")
	q.Set("originator", "pizzapi")
	u.RawQuery = q.Encode()
	return u.String()
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	TokenType    string `json:"token_type"`
}

func exchangeOpenAICode(code, verifier string) (*Credential, error) {
	data := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {OpenAIClientID},
		"code":          {code},
		"code_verifier": {verifier},
		"redirect_uri":  {OpenAIRedirectURI},
	}

	resp, err := http.PostForm(OpenAITokenURL, data)
	if err != nil {
		return nil, fmt.Errorf("token exchange request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("token exchange failed (status %d): %s", resp.StatusCode, string(body))
	}

	var tokenResp tokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return nil, fmt.Errorf("decode token response: %w", err)
	}

	if tokenResp.AccessToken == "" || tokenResp.RefreshToken == "" {
		return nil, fmt.Errorf("token response missing required fields")
	}

	return &Credential{
		Type:    CredTypeOAuth,
		Access:  tokenResp.AccessToken,
		Refresh: tokenResp.RefreshToken,
		Expires: time.Now().UnixMilli() + int64(tokenResp.ExpiresIn)*1000,
	}, nil
}

// extractOpenAIAccountID decodes the JWT access token and extracts the
// ChatGPT account ID from the `https://api.openai.com/auth` claim.
func extractOpenAIAccountID(accessToken string) string {
	parts := strings.SplitN(accessToken, ".", 3)
	if len(parts) != 3 {
		return ""
	}

	// Decode base64url payload (add padding if needed)
	payload := parts[1]
	switch len(payload) % 4 {
	case 2:
		payload += "=="
	case 3:
		payload += "="
	}

	decoded, err := decodeBase64URL(payload)
	if err != nil {
		return ""
	}

	var claims map[string]any
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return ""
	}

	authClaim, ok := claims[OpenAIJWTClaimPath].(map[string]any)
	if !ok {
		return ""
	}

	accountID, _ := authClaim["chatgpt_account_id"].(string)
	return accountID
}

func decodeBase64URL(s string) ([]byte, error) {
	// base64url → standard base64
	s = strings.ReplaceAll(s, "-", "+")
	s = strings.ReplaceAll(s, "_", "/")

	return b64.StdEncoding.DecodeString(s)
}

// startCallbackServer starts an HTTP server on localhost:1455 that catches
// the OAuth redirect and extracts the authorization code.
func startCallbackServer(expectedState string, codeCh chan<- string, errCh chan<- error) (*http.Server, error) {
	mux := http.NewServeMux()

	mux.HandleFunc("/auth/callback", func(w http.ResponseWriter, r *http.Request) {
		state := r.URL.Query().Get("state")
		if state != expectedState {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, htmlError("State mismatch. Please try logging in again."))
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
		fmt.Fprint(w, htmlSuccess("Authentication successful! You can close this window."))

		// Send code to channel (non-blocking)
		select {
		case codeCh <- code:
		default:
		}
	})

	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", OpenAICallbackPort))
	if err != nil {
		return nil, fmt.Errorf("bind port %d: %w", OpenAICallbackPort, err)
	}

	server := &http.Server{Handler: mux}
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			select {
			case errCh <- err:
			default:
			}
		}
	}()

	return server, nil
}

func htmlSuccess(message string) string {
	return fmt.Sprintf(`<!DOCTYPE html>
<html><head><title>PizzaPi Auth</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e7eb}
.card{text-align:center;padding:2rem;border-radius:12px;background:#1a1a2e;border:1px solid #333}
.icon{font-size:3rem;margin-bottom:1rem}</style></head>
<body><div class="card"><div class="icon">✅</div><h2>%s</h2></div></body></html>`, message)
}

func htmlError(message string) string {
	return fmt.Sprintf(`<!DOCTYPE html>
<html><head><title>PizzaPi Auth</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e7eb}
.card{text-align:center;padding:2rem;border-radius:12px;background:#2e1a1a;border:1px solid #633}
.icon{font-size:3rem;margin-bottom:1rem}</style></head>
<body><div class="card"><div class="icon">❌</div><h2>%s</h2></div></body></html>`, message)
}
