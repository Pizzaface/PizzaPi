package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// GitHub Copilot OAuth Device Code flow constants.
const (
	CopilotClientID       = "Iv1.b507a08c87ecfe98"
	CopilotDeviceCodeURL  = "https://github.com/login/device/code"
	CopilotAccessTokenURL = "https://github.com/login/oauth/access_token"
	CopilotTokenURL       = "https://api.github.com/copilot_internal/v2/token"
)

// CopilotHeaders are the extra headers required by the Copilot API.
var CopilotHeaders = map[string]string{
	"Editor-Version":        "vscode/1.90.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"User-Agent":            "GitHubCopilotChat/0.35.0",
}

// deviceCodeResponse is the response from the device code endpoint.
type deviceCodeResponse struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	ExpiresIn       int    `json:"expires_in"`
	Interval        int    `json:"interval"`
}

// pollTokenResponse is the response from the access token polling endpoint.
type pollTokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	Scope       string `json:"scope"`
	Error       string `json:"error"`
}

// copilotTokenResponse is the response from the Copilot internal token endpoint.
type copilotTokenResponse struct {
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expires_at"` // Unix seconds
}

// LoginGitHubCopilot runs the GitHub Copilot OAuth Device Code login flow:
//  1. Request a device code from GitHub
//  2. Direct the user to github.com/login/device with the user code
//  3. Poll for the GitHub access token
//  4. Exchange the GitHub access token for a short-lived Copilot API token
func LoginGitHubCopilot(ctx context.Context, callbacks LoginCallbacks) (*Credential, error) {
	// Step 1: request device code
	dcResp, err := requestCopilotDeviceCode(ctx)
	if err != nil {
		return nil, fmt.Errorf("request device code: %w", err)
	}

	// Step 2: notify UI — user visits verification URI and enters the user_code
	if callbacks.OnAuth != nil {
		callbacks.OnAuth(dcResp.VerificationURI, "Enter code: "+dcResp.UserCode)
	}
	if callbacks.OnProgress != nil {
		callbacks.OnProgress("Waiting for GitHub authorization...")
	}

	// Step 3: poll for GitHub access token
	githubToken, err := pollCopilotAccessToken(ctx, dcResp)
	if err != nil {
		return nil, fmt.Errorf("poll for access token: %w", err)
	}

	if callbacks.OnProgress != nil {
		callbacks.OnProgress("Fetching Copilot token...")
	}

	// Step 4: exchange GitHub token for Copilot token
	cred, err := fetchCopilotToken(githubToken)
	if err != nil {
		return nil, fmt.Errorf("fetch copilot token: %w", err)
	}

	if callbacks.OnProgress != nil {
		callbacks.OnProgress("Login successful!")
	}

	return cred, nil
}

// RefreshGitHubCopilotToken uses a stored GitHub access token (the Refresh
// field) to obtain a fresh short-lived Copilot API token. The GitHub access
// token is preserved unchanged as the new Refresh field.
func RefreshGitHubCopilotToken(refreshToken string) (*Credential, error) {
	return fetchCopilotToken(refreshToken)
}

// GetCopilotBaseURL derives the Copilot API base URL from the opaque token
// string. The token is semicolon-delimited key=value pairs; the proxy-ep
// field contains the proxy hostname. We replace the "proxy." prefix with
// "api." to get the public API hostname.
//
// Example token fragment: tid=xxx;exp=yyy;proxy-ep=proxy.individual.githubcopilot.com;...
// → https://api.individual.githubcopilot.com
func GetCopilotBaseURL(copilotToken string) string {
	const fallback = "https://api.individual.githubcopilot.com"

	for _, part := range strings.Split(copilotToken, ";") {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		if strings.TrimSpace(kv[0]) == "proxy-ep" {
			host := strings.TrimSpace(kv[1])
			if host == "" {
				break
			}
			if strings.HasPrefix(host, "proxy.") {
				host = "api." + host[len("proxy."):]
			}
			return "https://" + host
		}
	}

	return fallback
}

// --- internal helpers ---

func requestCopilotDeviceCode(ctx context.Context) (*deviceCodeResponse, error) {
	form := url.Values{
		"client_id": {CopilotClientID},
		"scope":     {"read:user"},
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, CopilotDeviceCodeURL,
		strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "GitHubCopilotChat/0.35.0")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("device code request failed (status %d): %s", resp.StatusCode, string(body))
	}

	var dcResp deviceCodeResponse
	if err := json.NewDecoder(resp.Body).Decode(&dcResp); err != nil {
		return nil, fmt.Errorf("decode device code response: %w", err)
	}

	if dcResp.DeviceCode == "" || dcResp.UserCode == "" {
		return nil, fmt.Errorf("device code response missing required fields")
	}

	// Default poll interval to 5 seconds if GitHub didn't provide one
	if dcResp.Interval <= 0 {
		dcResp.Interval = 5
	}

	return &dcResp, nil
}

// pollCopilotAccessToken polls GitHub until the user completes device
// authorization or the context is cancelled. It respects the "slow_down"
// error by adding 5 seconds to the polling interval.
func pollCopilotAccessToken(ctx context.Context, dcResp *deviceCodeResponse) (string, error) {
	interval := time.Duration(dcResp.Interval) * time.Second

	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(interval):
		}

		form := url.Values{
			"client_id":   {CopilotClientID},
			"device_code": {dcResp.DeviceCode},
			"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, CopilotAccessTokenURL,
			strings.NewReader(form.Encode()))
		if err != nil {
			return "", err
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("User-Agent", "GitHubCopilotChat/0.35.0")

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return "", err
		}

		var pollResp pollTokenResponse
		decodeErr := json.NewDecoder(resp.Body).Decode(&pollResp)
		resp.Body.Close()

		if resp.StatusCode != http.StatusOK && decodeErr != nil {
			return "", fmt.Errorf("access token poll failed (status %d)", resp.StatusCode)
		}

		switch pollResp.Error {
		case "":
			// Success
			if pollResp.AccessToken == "" {
				return "", fmt.Errorf("access token response missing token")
			}
			return pollResp.AccessToken, nil

		case "authorization_pending":
			// User hasn't completed device authorization yet — keep polling

		case "slow_down":
			// GitHub is asking us to back off
			interval += 5 * time.Second

		case "expired_token":
			return "", fmt.Errorf("device code expired; please try logging in again")

		case "access_denied":
			return "", fmt.Errorf("access denied by user")

		default:
			return "", fmt.Errorf("unexpected poll error: %s", pollResp.Error)
		}
	}
}

// fetchCopilotToken exchanges a GitHub OAuth access token for a short-lived
// Copilot API token from the internal GitHub Copilot endpoint.
func fetchCopilotToken(githubAccessToken string) (*Credential, error) {
	req, err := http.NewRequest(http.MethodGet, CopilotTokenURL, nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+githubAccessToken)
	for k, v := range CopilotHeaders {
		req.Header.Set(k, v)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("copilot token request failed (status %d): %s", resp.StatusCode, string(body))
	}

	var ctResp copilotTokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&ctResp); err != nil {
		return nil, fmt.Errorf("decode copilot token response: %w", err)
	}

	if ctResp.Token == "" {
		return nil, fmt.Errorf("copilot token response missing token field")
	}

	// expires_at is Unix seconds; store as millis to match Credential convention
	var expiresMs int64
	if ctResp.ExpiresAt > 0 {
		expiresMs = ctResp.ExpiresAt * 1000
	}

	return &Credential{
		Type:    CredTypeOAuth,
		Access:  ctResp.Token,
		Refresh: githubAccessToken,
		Expires: expiresMs,
	}, nil
}
