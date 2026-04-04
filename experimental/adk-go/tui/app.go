package tui

import (
	tea "github.com/charmbracelet/bubbletea"
)

// App is the top-level Bubble Tea model.
type App struct {
	state         AppState
	initialPrompt string // if set, sent on first connection
}

// New creates a new App with the given session controller.
func New(session SessionController) App {
	return App{state: newAppState(session)}
}

// WithInitialPrompt sets a prompt to send when the session starts.
func (a App) WithInitialPrompt(prompt string) App {
	a.initialPrompt = prompt
	return a
}

// Init satisfies tea.Model. Starts the session.
func (a App) Init() tea.Cmd {
	var cmds []tea.Cmd

	// Start the session (local or relay)
	if a.state.Session != nil {
		prompt := a.initialPrompt
		cmds = append(cmds, a.state.Session.Start(prompt))
	}

	return tea.Batch(cmds...)
}

// Update satisfies tea.Model.
func (a App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	return update(a, msg)
}

// View satisfies tea.Model.
func (a App) View() string {
	return view(a.state)
}
