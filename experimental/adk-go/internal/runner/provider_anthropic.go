package runner

import (
	"log"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/auth"
	anthprovider "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/providers/anthropicapi"
)

type AnthropicProviderAdapter struct{ inner *anthprovider.Provider }

func NewAnthropicProviderAdapter(authStorage *auth.Storage) *AnthropicProviderAdapter {
	return &AnthropicProviderAdapter{inner: anthprovider.NewAnthropicProvider(authStorage, log.Default())}
}

func (a *AnthropicProviderAdapter) Start(pctx ProviderContext) (<-chan RelayEvent, error) {
	return a.inner.Start(anthprovider.ProviderContext{Prompt: pctx.Prompt, Cwd: pctx.Cwd, Model: pctx.Model, OnStderr: pctx.OnStderr, HomeDir: pctx.HomeDir})
}
func (a *AnthropicProviderAdapter) SendMessage(text string) error { return a.inner.SendMessage(text) }
func (a *AnthropicProviderAdapter) Done() <-chan struct{}         { return a.inner.Done() }
func (a *AnthropicProviderAdapter) ExitCode() int                 { return a.inner.ExitCode() }
func (a *AnthropicProviderAdapter) Stop() error                   { return a.inner.Stop() }
