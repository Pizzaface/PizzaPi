package runner

import (
	"log"

	"github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/auth"
	anthprovider "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/providers/anthropicapi"
)

type GitHubCopilotProviderAdapter struct{ inner *anthprovider.Provider }

func NewGitHubCopilotProviderAdapter(authStorage *auth.Storage) *GitHubCopilotProviderAdapter {
	return &GitHubCopilotProviderAdapter{inner: anthprovider.NewCopilotProvider(authStorage, log.Default())}
}

func (a *GitHubCopilotProviderAdapter) Start(pctx ProviderContext) (<-chan RelayEvent, error) {
	return a.inner.Start(anthprovider.ProviderContext{Prompt: pctx.Prompt, Cwd: pctx.Cwd, Model: pctx.Model, OnStderr: pctx.OnStderr, HomeDir: pctx.HomeDir})
}
func (a *GitHubCopilotProviderAdapter) SendMessage(text string) error { return a.inner.SendMessage(text) }
func (a *GitHubCopilotProviderAdapter) Done() <-chan struct{}         { return a.inner.Done() }
func (a *GitHubCopilotProviderAdapter) ExitCode() int                 { return a.inner.ExitCode() }
func (a *GitHubCopilotProviderAdapter) Stop() error                   { return a.inner.Stop() }
