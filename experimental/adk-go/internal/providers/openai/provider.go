// Package openai implements a Provider that calls the OpenAI Chat Completions
// API directly, with OAuth authentication via ChatGPT Plus/Pro subscriptions.
package openai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/auth"
)

const (
	DefaultModel   = "gpt-4o"
	DefaultBaseURL = "https://api.openai.com/v1"
	ProviderName   = "openai"
	APIKeyEnvVar   = "OPENAI_API_KEY"
	// OAuth provider ID for credential storage
	OAuthProviderID = "openai-codex"
)

// RelayEvent is a PizzaPi relay-compatible event map.
type RelayEvent = map[string]any

// ProviderContext carries config for starting a session.
type ProviderContext struct {
	Prompt   string
	Cwd      string
	Model    string
	OnStderr func(string)
	HomeDir  string
}

// Provider implements the PizzaPi runner.Provider interface using the
// OpenAI Chat Completions API with OAuth or API key authentication.
type Provider struct {
	logger      *log.Logger
	authStorage *auth.Storage

	events chan RelayEvent
	done   chan struct{}
	cancel context.CancelFunc

	mu       sync.Mutex
	started  bool
	messages []chatMessage // conversation history
	model    string
	apiKey   string
	baseURL  string
	cwd      string
	seq      int
}

// NewProvider creates a new OpenAI provider.
func NewProvider(authStorage *auth.Storage, logger *log.Logger) *Provider {
	if logger == nil {
		logger = log.Default()
	}
	if authStorage == nil {
		authStorage = auth.NewStorage("")
	}
	return &Provider{
		logger:      logger,
		authStorage: authStorage,
		events:      make(chan RelayEvent, 128),
		done:        make(chan struct{}),
		baseURL:     DefaultBaseURL,
	}
}

// NeedsLogin returns true if no OpenAI credentials exist (OAuth or API key).
func (p *Provider) NeedsLogin() bool {
	// Check auth storage for OAuth creds
	if p.authStorage.Has(OAuthProviderID) {
		return false
	}
	// Check env var
	if os.Getenv(APIKeyEnvVar) != "" {
		return false
	}
	return true
}

// Start launches the provider and begins processing.
func (p *Provider) Start(pctx ProviderContext) (<-chan RelayEvent, error) {
	p.mu.Lock()
	if p.started {
		p.mu.Unlock()
		return nil, fmt.Errorf("provider already started")
	}
	p.started = true
	p.mu.Unlock()

	p.model = pctx.Model
	if p.model == "" {
		p.model = DefaultModel
	}
	p.cwd = pctx.Cwd

	// Resolve API key — OAuth first, then env var
	apiKey, err := p.authStorage.GetAPIKey(OAuthProviderID, APIKeyEnvVar)
	if err != nil {
		close(p.events)
		close(p.done)
		return nil, fmt.Errorf("resolve OpenAI credentials: %w", err)
	}
	if apiKey == "" {
		close(p.events)
		close(p.done)
		return nil, fmt.Errorf("no OpenAI credentials found — run with --login to authenticate via ChatGPT, or set %s", APIKeyEnvVar)
	}
	p.apiKey = apiKey

	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel

	// Initialize conversation with system message
	p.messages = []chatMessage{
		{Role: "system", Content: systemPrompt(p.cwd)},
	}

	// Start the first turn
	go p.runTurn(ctx, pctx.Prompt)

	return p.events, nil
}

// SendMessage sends a follow-up user message.
func (p *Provider) SendMessage(text string) error {
	p.mu.Lock()
	if !p.started {
		p.mu.Unlock()
		return fmt.Errorf("provider not started")
	}
	p.mu.Unlock()

	ctx := context.Background()
	go p.runTurn(ctx, text)
	return nil
}

// Done returns a channel that closes when the provider exits.
func (p *Provider) Done() <-chan struct{} { return p.done }

// ExitCode returns -1 (no process exit code for API providers).
func (p *Provider) ExitCode() int { return -1 }

// Stop terminates the provider.
func (p *Provider) Stop() error {
	if p.cancel != nil {
		p.cancel()
	}
	return nil
}

// runTurn sends a user message and processes the streaming response.
func (p *Provider) runTurn(ctx context.Context, prompt string) {
	p.mu.Lock()
	p.seq++
	userMsgID := fmt.Sprintf("user_%02d", p.seq)
	p.messages = append(p.messages, chatMessage{Role: "user", Content: prompt})
	p.mu.Unlock()

	// Emit heartbeat (active)
	p.emit(RelayEvent{
		"type": "heartbeat", "active": true, "isCompacting": false,
		"ts": nowMillis(), "model": p.modelMap(), "cwd": p.cwd,
	})

	// Emit user message
	p.emit(RelayEvent{
		"type":      "session_active",
		"state":     map[string]any{"messages": p.relayMessages(), "model": p.modelMap(), "cwd": p.cwd},
	})
	_ = userMsgID

	// Call the completions API
	p.seq++
	assistantMsgID := fmt.Sprintf("msg_%02d", p.seq)

	// Emit message_start
	p.emit(RelayEvent{
		"type": "message_start",
		"message": map[string]any{"role": "assistant", "id": assistantMsgID},
	})

	response, inputTok, outputTok, err := p.callCompletionsAPI(ctx)
	if err != nil {
		p.logger.Printf("[openai] API error: %v", err)
		p.emit(RelayEvent{
			"type": "tool_result_message", "role": "tool_result",
			"toolCallId": "", "toolName": "system",
			"content": fmt.Sprintf("Error: %v", err), "isError": true,
			"timestamp": nowMillis(),
		})
		p.emit(RelayEvent{"type": "heartbeat", "active": false, "isCompacting": false,
			"ts": nowMillis(), "model": p.modelMap(), "cwd": p.cwd})
		return
	}

	// Add to conversation history
	p.mu.Lock()
	p.messages = append(p.messages, chatMessage{Role: "assistant", Content: response})
	p.mu.Unlock()

	// Emit final message
	msg := map[string]any{
		"role": "assistant", "id": assistantMsgID,
		"content":   []map[string]any{{"type": "text", "text": response}},
		"timestamp": nowMillis(),
	}
	p.emit(RelayEvent{"type": "message_update", "message": msg})
	p.emit(RelayEvent{"type": "message_end", "message": msg})

	// Emit metadata + idle heartbeat
	p.emit(RelayEvent{
		"type": "session_metadata_update", "model": p.modelMap(),
		"usage": map[string]any{"inputTokens": inputTok, "outputTokens": outputTok},
		"costUSD": 0, "numTurns": 1, "stopReason": "stop",
	})
	p.emit(RelayEvent{
		"type": "heartbeat", "active": false, "isCompacting": false,
		"ts": nowMillis(), "model": p.modelMap(), "cwd": p.cwd,
	})
}

// callCompletionsAPI makes a POST to the OpenAI chat completions endpoint.
// Returns the assistant response text and token counts.
func (p *Provider) callCompletionsAPI(ctx context.Context) (string, int, int, error) {
	p.mu.Lock()
	msgs := make([]chatMessage, len(p.messages))
	copy(msgs, p.messages)
	p.mu.Unlock()

	body := completionRequest{
		Model:    p.model,
		Messages: msgs,
	}

	bodyJSON, err := json.Marshal(body)
	if err != nil {
		return "", 0, 0, err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", p.baseURL+"/chat/completions", bytes.NewReader(bodyJSON))
	if err != nil {
		return "", 0, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", 0, 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return "", 0, 0, fmt.Errorf("OpenAI API error (status %d): %s", resp.StatusCode, string(respBody))
	}

	var result completionResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", 0, 0, fmt.Errorf("decode response: %w", err)
	}

	if len(result.Choices) == 0 {
		return "", 0, 0, fmt.Errorf("empty response (no choices)")
	}

	text := result.Choices[0].Message.Content
	inputTok := result.Usage.PromptTokens
	outputTok := result.Usage.CompletionTokens

	return text, inputTok, outputTok, nil
}

func (p *Provider) emit(ev RelayEvent) {
	select {
	case p.events <- ev:
	default:
		p.logger.Printf("[openai] event channel full, dropping type=%v", ev["type"])
	}
}

func (p *Provider) modelMap() map[string]any {
	return map[string]any{"provider": "openai", "id": p.model}
}

func (p *Provider) relayMessages() []any {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []any
	for _, m := range p.messages {
		if m.Role == "system" {
			continue
		}
		out = append(out, map[string]any{
			"role":    m.Role,
			"content": []any{map[string]any{"type": "text", "text": m.Content}},
		})
	}
	return out
}

func nowMillis() int64 { return time.Now().UnixMilli() }

// --- API types ---

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type completionRequest struct {
	Model    string        `json:"model"`
	Messages []chatMessage `json:"messages"`
}

type completionResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}

func systemPrompt(cwd string) string {
	return fmt.Sprintf(`You are a helpful coding assistant. You have access to tools for reading files, writing files, editing files, and running bash commands.

Working directory: %s

Be concise in your responses. Show file paths clearly when working with files.`, cwd)
}

// RegisterOAuthRefresher registers the OpenAI token refresher with auth storage.
func RegisterOAuthRefresher(storage *auth.Storage) {
	storage.RegisterRefresher(OAuthProviderID, func(refreshToken string) (*auth.Credential, error) {
		return auth.RefreshOpenAIToken(refreshToken)
	})
}
