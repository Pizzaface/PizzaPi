package auth

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

// Anthropic OAuth constants for Claude Pro/Max subscriptions.
const (
	AnthropicClientID     = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	AnthropicAuthorizeURL = "https://claude.ai/oauth/authorize"
	AnthropicTokenURL     = "https://platform.claude.com/v1/oauth/token"
	AnthropicRedirectURI  = "http://localhost:53692/callback"
	AnthropicCallbackPort = 53692
	AnthropicScopes       = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
)

// LoginAnthropic runs the full Anthropic OAuth 2.0 + PKCE login flow:
//  1. Generate PKCE verifier/challenge
//  2. Build authorization URL
//  3. Start local callback server on :53692
//  4. Wait for user to complete browser login
//  5. Exchange authorization code for tokens
//
// The returned Credential.Access is the OAuth access token, which is used
// directly as the Anthropic API key.
func LoginAnthropic(ctx context.Context, callbacks LoginCallbacks) (*Credential, error) {
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
	authURL := buildAnthropicAuthURL(pkce.Challenge, state)

	// 4. Start local callback server
	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)
	server, err := startAnthropicCallbackServer(state, codeCh, errCh)
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
	cred, err := exchangeAnthropicCode(code, pkce.Verifier)
	if err != nil {
		return nil, fmt.Errorf("exchange code: %w", err)
	}

	if callbacks.OnProgress != nil {
		callbacks.OnProgress("Login successful!")
	}

	return cred, nil
}

// RefreshAnthropicToken refreshes an expired Anthropic OAuth access token.
// The token endpoint expects a JSON body (not form-encoded).
func RefreshAnthropicToken(refreshToken string) (*Credential, error) {
	reqBody := map[string]string{
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
		"client_id":     AnthropicClientID,
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal refresh request: %w", err)
	}

	resp, err := http.Post(AnthropicTokenURL, "application/json", bytes.NewReader(bodyBytes))
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

	if tokenResp.AccessToken == "" {
		return nil, fmt.Errorf("refresh response missing access_token")
	}

	return &Credential{
		Type:    CredTypeOAuth,
		Access:  tokenResp.AccessToken,
		Refresh: tokenResp.RefreshToken,
		Expires: time.Now().UnixMilli() + int64(tokenResp.ExpiresIn)*1000,
	}, nil
}

// --- internal helpers ---

func buildAnthropicAuthURL(challenge, state string) string {
	u, _ := url.Parse(AnthropicAuthorizeURL)
	q := u.Query()
	q.Set("response_type", "code")
	q.Set("client_id", AnthropicClientID)
	q.Set("redirect_uri", AnthropicRedirectURI)
	q.Set("scope", AnthropicScopes)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("state", state)
	u.RawQuery = q.Encode()
	return u.String()
}

// exchangeAnthropicCode exchanges an authorization code for tokens.
// Anthropic's token endpoint requires a JSON body, unlike OpenAI which uses
// form-encoded data.
func exchangeAnthropicCode(code, verifier string) (*Credential, error) {
	reqBody := map[string]string{
		"grant_type":    "authorization_code",
		"client_id":     AnthropicClientID,
		"code":          code,
		"code_verifier": verifier,
		"redirect_uri":  AnthropicRedirectURI,
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal token request: %w", err)
	}

	resp, err := http.Post(AnthropicTokenURL, "application/json", bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("token exchange request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("token exchange failed (status %d): %s", resp.StatusCode, string(respBody))
	}

	var tokenResp tokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return nil, fmt.Errorf("decode token response: %w", err)
	}

	if tokenResp.AccessToken == "" {
		return nil, fmt.Errorf("token response missing access_token")
	}

	return &Credential{
		Type:    CredTypeOAuth,
		Access:  tokenResp.AccessToken,
		Refresh: tokenResp.RefreshToken,
		Expires: time.Now().UnixMilli() + int64(tokenResp.ExpiresIn)*1000,
	}, nil
}

// startAnthropicCallbackServer starts an HTTP server on localhost:53692 that
// catches the Anthropic OAuth redirect and extracts the authorization code.
func startAnthropicCallbackServer(expectedState string, codeCh chan<- string, errCh chan<- error) (*http.Server, error) {
	mux := http.NewServeMux()

	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
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

	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", AnthropicCallbackPort))
	if err != nil {
		return nil, fmt.Errorf("bind port %d: %w", AnthropicCallbackPort, err)
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
