package tui

import (
	tea "github.com/charmbracelet/bubbletea"
)

// App is the top-level Bubble Tea model.
type App struct {
	state AppState
}

// New creates a new App with default state and the given relay config.
func New(relayURL, apiKey, sessionID string) App {
	return App{state: newAppState(relayURL, apiKey, sessionID)}
}

// WithComponent registers an extension component before the app starts.
func (a App) WithComponent(c Component) App {
	a.state.Components.Register(c)
	return a
}

// Init satisfies tea.Model. Starts the relay connection if configured.
func (a App) Init() tea.Cmd {
	var cmds []tea.Cmd

	// Initialize extension components
	for _, c := range a.state.Components.All() {
		if cmd := c.Init(); cmd != nil {
			cmds = append(cmds, cmd)
		}
	}

	// Start relay connection if URL is configured
	if a.state.RelayURL != "" {
		cmds = append(cmds, connectToRelay(a.state.RelayURL, a.state.APIKey, a.state.SessionID))
	}

	return tea.Batch(cmds...)
}

// Update satisfies tea.Model. Delegates to the update handler.
func (a App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	return update(a, msg)
}

// View satisfies tea.Model. Delegates to the view renderer.
func (a App) View() string {
	return view(a.state)
}
