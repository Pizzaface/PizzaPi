// Package main re-exports the Provider interface from internal/runner.
package main

import "github.com/Pizzaface/PizzaPi/experimental/adk-go/internal/runner"

// Type aliases — the daemon code keeps using these names.
type Provider = runner.Provider
type ProviderContext = runner.ProviderContext
type RelayEvent = runner.RelayEvent
