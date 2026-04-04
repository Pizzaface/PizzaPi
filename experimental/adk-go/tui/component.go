// Package tui implements a Bubble Tea TUI for the ADK Go runner.
//
// The TUI is designed around a Component interface that allows extensibility.
// Built-in components include the session sidebar and message panel; future
// extensions (service panels, trigger views, etc.) can implement Component
// and register themselves via the ComponentRegistry.
package tui

import tea "github.com/charmbracelet/bubbletea"

// Component is the extension interface for TUI panels and views.
// Each component manages its own state and renders into a region
// of the terminal. Components receive all tea.Msg updates and can
// return commands.
type Component interface {
	// Name returns a unique identifier for this component.
	Name() string

	// Init returns the initial command for the component.
	Init() tea.Cmd

	// Update handles a message and returns updated state + optional command.
	Update(msg tea.Msg) (Component, tea.Cmd)

	// View renders the component into a string given width and height constraints.
	View(width, height int) string
}

// ComponentRegistry holds registered extension components.
// Components are rendered in registration order in the extension panel area.
type ComponentRegistry struct {
	components []Component
	byName     map[string]int // name → index in components slice
}

// NewComponentRegistry creates an empty registry.
func NewComponentRegistry() *ComponentRegistry {
	return &ComponentRegistry{
		byName: make(map[string]int),
	}
}

// Register adds a component to the registry. If a component with the same
// name already exists, it is replaced.
func (r *ComponentRegistry) Register(c Component) {
	name := c.Name()
	if idx, ok := r.byName[name]; ok {
		r.components[idx] = c
		return
	}
	r.byName[name] = len(r.components)
	r.components = append(r.components, c)
}

// All returns all registered components in registration order.
func (r *ComponentRegistry) All() []Component {
	out := make([]Component, len(r.components))
	copy(out, r.components)
	return out
}

// Get returns a component by name, or nil if not found.
func (r *ComponentRegistry) Get(name string) Component {
	if idx, ok := r.byName[name]; ok {
		return r.components[idx]
	}
	return nil
}

// Len returns the number of registered components.
func (r *ComponentRegistry) Len() int {
	return len(r.components)
}
