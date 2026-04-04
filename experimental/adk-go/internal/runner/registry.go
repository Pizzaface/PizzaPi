package runner

import (
	"fmt"
	"log"
	"sort"
	"sync"
)

// Registry holds registered provider factories, keyed by name.
// Thread-safe for concurrent registration and lookup.
type Registry struct {
	mu        sync.RWMutex
	factories map[string]ProviderFactory
}

// NewRegistry creates an empty provider registry.
func NewRegistry() *Registry {
	return &Registry{
		factories: make(map[string]ProviderFactory),
	}
}

// Register adds a provider factory under the given name.
// If a factory with the same name exists, it is replaced.
func (r *Registry) Register(name string, factory ProviderFactory) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.factories[name] = factory
}

// Get returns the provider factory for the given name, or an error if not found.
func (r *Registry) Get(name string) (ProviderFactory, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	f, ok := r.factories[name]
	if !ok {
		return nil, fmt.Errorf("unknown provider %q (available: %v)", name, r.Names())
	}
	return f, nil
}

// Names returns all registered provider names in sorted order.
func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	names := make([]string, 0, len(r.factories))
	for name := range r.factories {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// DefaultRegistry is the global provider registry with built-in providers.
var DefaultRegistry = func() *Registry {
	r := NewRegistry()
	r.Register("claude-cli", func() Provider {
		return NewClaudeCLIProvider(log.Default())
	})
	return r
}()
