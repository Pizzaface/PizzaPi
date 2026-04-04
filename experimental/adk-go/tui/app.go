package tui

import (
	tea "github.com/charmbracelet/bubbletea"
)

// App is the top-level Bubble Tea model.
type App struct {
	state        AppState
	initialPrompt string // if set, sent on first connection
}

// New creates a new App with the given session controller.
// Use NewLocalSession or NewRemoteSession to create the controller.
func New(session SessionController) App {
	return App{state: newAppState(session)}
}

// WithInitialPrompt sets a prompt to send when the session starts.
func (a App) WithInitialPrompt(prompt string) App {
	a.initialPrompt = prompt
	return a
}

// WithComponent registers an extension component before the app starts.
func (a App) WithComponent(c Component) App {
	a.state.Components.Register(c)
	return a
}

// Init satisfies tea.Model. Starts the session.
func (a App) Init() tea.Cmd {
	var cmds []tea.Cmd

	// Initialize extension components
	for _, c := range a.state.Components.All() {
		if cmd := c.Init(); cmd != nil {
			cmds = append(cmds, cmd)
		}
	}

	// Start the session (local or relay)
	if a.state.Session != nil {
		prompt := a.initialPrompt
		cmds = append(cmds, a.state.Session.Start(prompt))
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
