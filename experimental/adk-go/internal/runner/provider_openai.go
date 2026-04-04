package runner

import (
	"log"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/auth"
	oaiprovider "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/providers/openai"
)

// OpenAIProviderAdapter wraps an openai.Provider to implement runner.Provider.
type OpenAIProviderAdapter struct {
	inner *oaiprovider.Provider
}

// NewOpenAIProviderAdapter creates an adapter for the OpenAI provider.
func NewOpenAIProviderAdapter(authStorage *auth.Storage) *OpenAIProviderAdapter {
	return &OpenAIProviderAdapter{
		inner: oaiprovider.NewProvider(authStorage, log.Default()),
	}
}

func (a *OpenAIProviderAdapter) Start(pctx ProviderContext) (<-chan RelayEvent, error) {
	return a.inner.Start(oaiprovider.ProviderContext{
		Prompt:   pctx.Prompt,
		Cwd:      pctx.Cwd,
		Model:    pctx.Model,
		OnStderr: pctx.OnStderr,
		HomeDir:  pctx.HomeDir,
	})
}

func (a *OpenAIProviderAdapter) SendMessage(text string) error {
	return a.inner.SendMessage(text)
}

func (a *OpenAIProviderAdapter) Done() <-chan struct{} {
	return a.inner.Done()
}

func (a *OpenAIProviderAdapter) ExitCode() int {
	return a.inner.ExitCode()
}

func (a *OpenAIProviderAdapter) Stop() error {
	return a.inner.Stop()
}
