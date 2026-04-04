package runner

import (
	"log"

	adkprovider "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/providers/adk"
)

// ADKProviderAdapter wraps an adk.Provider to implement the runner.Provider
// interface, bridging the adk.ProviderContext to runner.ProviderContext.
type ADKProviderAdapter struct {
	inner *adkprovider.Provider
}

// NewADKProviderAdapter creates an adapter for the given ADK backend config.
func NewADKProviderAdapter(backend adkprovider.BackendConfig) *ADKProviderAdapter {
	return &ADKProviderAdapter{
		inner: adkprovider.NewProvider(backend, log.Default()),
	}
}

func (a *ADKProviderAdapter) Start(pctx ProviderContext) (<-chan RelayEvent, error) {
	return a.inner.Start(adkprovider.ProviderContext{
		Prompt:   pctx.Prompt,
		Cwd:      pctx.Cwd,
		Model:    pctx.Model,
		OnStderr: pctx.OnStderr,
		HomeDir:  pctx.HomeDir,
	})
}

func (a *ADKProviderAdapter) SendMessage(text string) error {
	return a.inner.SendMessage(text)
}

func (a *ADKProviderAdapter) Done() <-chan struct{} {
	return a.inner.Done()
}

func (a *ADKProviderAdapter) ExitCode() int {
	return a.inner.ExitCode()
}

func (a *ADKProviderAdapter) Stop() error {
	return a.inner.Stop()
}
