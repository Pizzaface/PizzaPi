package anthropicapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/auth"
)

const (
	AnthropicProviderName   = "anthropic"
	AnthropicOAuthProvider  = "anthropic"
	AnthropicDefaultModel   = "claude-sonnet-4-5"
	AnthropicDefaultBaseURL = "https://api.anthropic.com"
	AnthropicAPIKeyEnvVar   = "ANTHROPIC_API_KEY"

	CopilotProviderName  = "github-copilot"
	CopilotOAuthProvider = "github-copilot"
	CopilotDefaultModel  = "claude-sonnet-4.5"
)

var (
	FallbackAnthropicModels = []string{
		"claude-3-5-haiku-latest",
		"claude-3-7-sonnet-latest",
		"claude-sonnet-4-5",
		"claude-opus-4-1",
	}
	FallbackCopilotModels = []string{
		"claude-sonnet-4.5",
		"claude-opus-4.5",
		"gemini-2.5-pro",
		"gpt-4.1",
		"o4-mini",
	}
)

var httpClient = http.DefaultClient

type RelayEvent = map[string]any

type ProviderContext struct {
	Prompt   string
	Cwd      string
	Model    string
	OnStderr func(string)
	HomeDir  string
}

type Config struct {
	ProviderName   string
	AuthProviderID string
	APIKeyEnvVar   string
	DefaultModel   string
	DefaultBaseURL string
	FallbackModels []string
	CopilotMode    bool
}

type Provider struct {
	logger      *log.Logger
	authStorage *auth.Storage
	config      Config

	events chan RelayEvent
	done   chan struct{}
	cancel context.CancelFunc

	mu       sync.Mutex
	started  bool
	messages []chatMessage
	model    string
	apiKey   string
	baseURL  string
	cwd      string
	seq      int
}

func NewProvider(config Config, authStorage *auth.Storage, logger *log.Logger) *Provider {
	if logger == nil {
		logger = log.Default()
	}
	if authStorage == nil {
		authStorage = auth.NewStorage("")
	}
	if config.DefaultBaseURL == "" {
		config.DefaultBaseURL = AnthropicDefaultBaseURL
	}
	return &Provider{
		logger:      logger,
		authStorage: authStorage,
		config:      config,
		events:      make(chan RelayEvent, 128),
		done:        make(chan struct{}),
		baseURL:     config.DefaultBaseURL,
	}
}

func NewAnthropicProvider(authStorage *auth.Storage, logger *log.Logger) *Provider {
	return NewProvider(Config{
		ProviderName:   AnthropicProviderName,
		AuthProviderID: AnthropicOAuthProvider,
		APIKeyEnvVar:   AnthropicAPIKeyEnvVar,
		DefaultModel:   AnthropicDefaultModel,
		DefaultBaseURL: AnthropicDefaultBaseURL,
		FallbackModels: FallbackAnthropicModels,
	}, authStorage, logger)
}

func NewCopilotProvider(authStorage *auth.Storage, logger *log.Logger) *Provider {
	return NewProvider(Config{
		ProviderName:   CopilotProviderName,
		AuthProviderID: CopilotOAuthProvider,
		DefaultModel:   CopilotDefaultModel,
		FallbackModels: FallbackCopilotModels,
		CopilotMode:    true,
	}, authStorage, logger)
}

func RegisterOAuthRefresher(storage *auth.Storage, providerID string) {
	switch providerID {
	case AnthropicOAuthProvider:
		storage.RegisterRefresher(providerID, func(refreshToken string) (*auth.Credential, error) {
			return auth.RefreshAnthropicToken(refreshToken)
		})
	case CopilotOAuthProvider:
		storage.RegisterRefresher(providerID, func(refreshToken string) (*auth.Credential, error) {
			return auth.RefreshGitHubCopilotToken(refreshToken)
		})
	}
}

func (p *Provider) NeedsLogin() bool {
	if p.authStorage.Has(p.config.AuthProviderID) {
		return false
	}
	if p.config.APIKeyEnvVar != "" && os.Getenv(p.config.APIKeyEnvVar) != "" {
		return false
	}
	return true
}

func (p *Provider) ListModels() ([]string, error) {
	apiKey, err := p.resolveAPIKey()
	if err != nil || apiKey == "" {
		return p.config.FallbackModels, nil
	}

	url := strings.TrimRight(p.resolveBaseURL(apiKey), "/")
	if p.config.CopilotMode {
		url += "/models"
	} else {
		url += "/v1/models"
	}

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		return p.config.FallbackModels, nil
	}
	p.applyHeaders(req, apiKey, false)

	resp, err := httpClient.Do(req)
	if err != nil {
		return p.config.FallbackModels, nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return p.config.FallbackModels, nil
	}

	var result struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models []struct {
			ID string `json:"id"`
		} `json:"models"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return p.config.FallbackModels, nil
	}
	var models []string
	for _, m := range result.Data {
		if m.ID != "" {
			models = append(models, m.ID)
		}
	}
	for _, m := range result.Models {
		if m.ID != "" {
			models = append(models, m.ID)
		}
	}
	if len(models) == 0 {
		return p.config.FallbackModels, nil
	}
	return models, nil
}

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
		p.model = p.config.DefaultModel
	}
	p.cwd = pctx.Cwd

	apiKey, err := p.resolveAPIKey()
	if err != nil {
		close(p.events)
		close(p.done)
		return nil, fmt.Errorf("resolve %s credentials: %w", p.config.ProviderName, err)
	}
	if apiKey == "" {
		close(p.events)
		close(p.done)
		return nil, fmt.Errorf("no %s credentials found", p.config.ProviderName)
	}
	p.apiKey = apiKey
	p.baseURL = p.resolveBaseURL(apiKey)

	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	p.messages = []chatMessage{{Role: "system", Content: systemPrompt(p.cwd)}}
	go p.runTurn(ctx, pctx.Prompt)
	return p.events, nil
}

func (p *Provider) SendMessage(text string) error {
	p.mu.Lock()
	if !p.started {
		p.mu.Unlock()
		return fmt.Errorf("provider not started")
	}
	p.mu.Unlock()
	go p.runTurn(context.Background(), text)
	return nil
}

func (p *Provider) Done() <-chan struct{} { return p.done }
func (p *Provider) ExitCode() int         { return -1 }
func (p *Provider) Stop() error {
	if p.cancel != nil {
		p.cancel()
	}
	return nil
}

func (p *Provider) runTurn(ctx context.Context, prompt string) {
	p.mu.Lock()
	p.seq++
	p.messages = append(p.messages, chatMessage{Role: "user", Content: prompt})
	p.mu.Unlock()

	p.emit(RelayEvent{"type": "heartbeat", "active": true, "isCompacting": false, "ts": nowMillis(), "model": p.modelMap(), "cwd": p.cwd})
	p.emit(RelayEvent{"type": "session_active", "state": map[string]any{"messages": p.relayMessages(), "model": p.modelMap(), "cwd": p.cwd}})

	p.seq++
	assistantMsgID := fmt.Sprintf("msg_%02d", p.seq)
	p.emit(RelayEvent{"type": "message_start", "message": map[string]any{"role": "assistant", "id": assistantMsgID}})

	response, inputTok, outputTok, err := p.callMessagesAPI(ctx)
	if err != nil {
		p.emit(RelayEvent{"type": "tool_result_message", "role": "tool_result", "toolName": "system", "content": fmt.Sprintf("Error: %v", err), "isError": true, "timestamp": nowMillis()})
		p.emit(RelayEvent{"type": "heartbeat", "active": false, "isCompacting": false, "ts": nowMillis(), "model": p.modelMap(), "cwd": p.cwd})
		return
	}

	p.mu.Lock()
	p.messages = append(p.messages, chatMessage{Role: "assistant", Content: response})
	p.mu.Unlock()

	msg := map[string]any{
		"role":      "assistant",
		"id":        assistantMsgID,
		"content":   []map[string]any{{"type": "text", "text": response}},
		"timestamp": nowMillis(),
	}
	p.emit(RelayEvent{"type": "message_update", "message": msg})
	p.emit(RelayEvent{"type": "message_end", "message": msg})
	p.emit(RelayEvent{"type": "session_metadata_update", "model": p.modelMap(), "usage": map[string]any{"inputTokens": inputTok, "outputTokens": outputTok}, "costUSD": 0, "numTurns": 1, "stopReason": "stop"})
	p.emit(RelayEvent{"type": "heartbeat", "active": false, "isCompacting": false, "ts": nowMillis(), "model": p.modelMap(), "cwd": p.cwd})
}

func (p *Provider) callMessagesAPI(ctx context.Context) (string, int, int, error) {
	p.mu.Lock()
		msgs := make([]chatMessage, len(p.messages))
		copy(msgs, p.messages)
	p.mu.Unlock()

	var messageBlocks []messageInput
	var system string
	for _, m := range msgs {
		switch m.Role {
		case "system":
			system = m.Content
		case "user", "assistant":
			messageBlocks = append(messageBlocks, messageInput{Role: m.Role, Content: []contentBlock{{Type: "text", Text: m.Content}}})
		}
	}

	body := messagesRequest{Model: p.model, Messages: messageBlocks, MaxTokens: 2048, Stream: false}
	if system != "" {
		body.System = system
	}
	bodyJSON, err := json.Marshal(body)
	if err != nil {
		return "", 0, 0, err
	}

	url := strings.TrimRight(p.baseURL, "/") + "/v1/messages"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(bodyJSON))
	if err != nil {
		return "", 0, 0, err
	}
	p.applyHeaders(req, p.apiKey, true)
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", 0, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", 0, 0, fmt.Errorf("%s API error (status %d): %s", p.config.ProviderName, resp.StatusCode, string(body))
	}

	var out messagesResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", 0, 0, err
	}
	var text strings.Builder
	for _, block := range out.Content {
		if block.Type == "text" {
			text.WriteString(block.Text)
		}
	}
	if text.Len() == 0 {
		return "", 0, 0, fmt.Errorf("empty response")
	}
	return text.String(), out.Usage.InputTokens, out.Usage.OutputTokens, nil
}

func (p *Provider) resolveBaseURL(apiKey string) string {
	if p.config.CopilotMode {
		return auth.GetCopilotBaseURL(apiKey)
	}
	if p.baseURL != "" {
		return p.baseURL
	}
	return p.config.DefaultBaseURL
}

func (p *Provider) resolveAPIKey() (string, error) {
	return p.authStorage.GetAPIKey(p.config.AuthProviderID, p.config.APIKeyEnvVar)
}

func (p *Provider) applyHeaders(req *http.Request, apiKey string, withJSON bool) {
	if withJSON {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("anthropic-dangerous-direct-browser-access", "true")
	if p.config.CopilotMode {
		req.Header.Set("Authorization", "Bearer "+apiKey)
		for k, v := range auth.CopilotHeaders {
			req.Header.Set(k, v)
		}
		req.Header.Set("Copilot-Integration-Id", "vscode-chat")
		req.Header.Set("x-interaction-type", "conversation-panel")
		return
	}
	if strings.Contains(apiKey, "sk-ant-oat") {
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("anthropic-beta", "claude-code-20250219,oauth-2025-04-20")
		req.Header.Set("user-agent", "claude-cli/0.0.0")
		req.Header.Set("x-app", "cli")
		return
	}
	req.Header.Set("x-api-key", apiKey)
}

func (p *Provider) emit(ev RelayEvent) {
	select {
	case p.events <- ev:
	default:
		p.logger.Printf("[%s] event channel full, dropping type=%v", p.config.ProviderName, ev["type"])
	}
}

func (p *Provider) modelMap() map[string]any {
	return map[string]any{"provider": p.config.ProviderName, "id": p.model}
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
			"role": m.Role,
			"content": []any{map[string]any{"type": "text", "text": m.Content}},
		})
	}
	return out
}

func nowMillis() int64 { return time.Now().UnixMilli() }

func systemPrompt(cwd string) string {
	return fmt.Sprintf(`You are a helpful coding assistant.\n\nWorking directory: %s`, cwd)
}

type chatMessage struct {
	Role    string
	Content string
}

type messagesRequest struct {
	Model     string         `json:"model"`
	System    string         `json:"system,omitempty"`
	Messages  []messageInput `json:"messages"`
	MaxTokens int            `json:"max_tokens"`
	Stream    bool           `json:"stream"`
}

type messageInput struct {
	Role    string         `json:"role"`
	Content []contentBlock `json:"content"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

type messagesResponse struct {
	Content []contentBlock `json:"content"`
	Usage   struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
}
