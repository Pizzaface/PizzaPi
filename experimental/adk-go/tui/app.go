// Package tui implements a minimal Bubble Tea TUI for the ADK Go runner.
package tui

import (
	tea "github.com/charmbracelet/bubbletea"
)

// App is the top-level Bubble Tea model.
type App struct {
	state AppState
}

// New creates a new App with default state.
func New() App {
	return App{state: newAppState()}
}

// Init satisfies tea.Model. No I/O commands needed at startup.
func (a App) Init() tea.Cmd {
	return nil
}

// Update satisfies tea.Model. Delegates to the update handler.
func (a App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	return update(a, msg)
}

// View satisfies tea.Model. Delegates to the view renderer.
func (a App) View() string {
	return view(a.state)
}
