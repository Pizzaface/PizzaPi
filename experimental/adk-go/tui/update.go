package tui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// update handles incoming messages and returns the next model and any command.
func update(a App, msg tea.Msg) (tea.Model, tea.Cmd) {
	s := a.state

	switch m := msg.(type) {
	case tea.WindowSizeMsg:
		s.Width = m.Width
		s.Height = m.Height
		a.state = s
		return a, nil

	case tea.KeyMsg:
		switch m.String() {
		case "ctrl+c", "q":
			return a, tea.Quit

		case "tab":
			if s.ActivePanel == PanelMain {
				s.ActivePanel = PanelSidebar
				s.Input.Blur()
			} else {
				s.ActivePanel = PanelMain
				s.Input.Focus()
			}
			a.state = s
			return a, nil

		case "up":
			s.ScrollOffset++
			a.state = s
			return a, nil

		case "down":
			if s.ScrollOffset > 0 {
				s.ScrollOffset--
			}
			a.state = s
			return a, nil

		case "enter":
			text := strings.TrimSpace(s.Input.Value())
			if text != "" {
				s.Messages = append(s.Messages, text)
				s.ScrollOffset = 0 // snap to bottom on new message
			}
			s.Input.SetValue("")
			a.state = s
			return a, nil
		}
	}

	// Forward remaining events to the input field when main panel is active.
	if s.ActivePanel == PanelMain {
		var cmd tea.Cmd
		s.Input, cmd = s.Input.Update(msg)
		a.state = s
		return a, cmd
	}

	a.state = s
	return a, nil
}
